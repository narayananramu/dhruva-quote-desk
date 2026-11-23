import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { Activities, Totals } from './activities';
import type { DeclineOutput } from './agents/guardrails';
import { detectInjection, gateDecision, plainDecision } from './agents/guardrails';
import { checkReasonCites } from './agents/grounding';
import { isCounter, rivalClaimIn } from './claims';
import { BUDGET, POLICY, WAITS } from './config';
import type { DeliveryOption, LossReason, SalesAction, TraceStep } from './contract';
import {
  addBusinessHours,
  checkFinancePrice,
  ruleInputsOf,
  deliveryText,
  EMPTY_REQUEST,
  fmtTime,
  inr,
  istDate,
  leadDaysOf,
  marginPct,
  parseStructured,
  paymentDaysIn,
  stockOption,
  type Evaluation,
  type RfqRequest,
  type TradeInputs,
} from './domain';
import type { AgentMeta } from './agents/types';
import type { ShortFacts } from './messages';
import type { QuoteInput, QuoteState, Status } from './state';

export { reviewQueueWorkflow } from './queue';
export type { QuoteInput, QuoteState } from './state';

// ---- Signals and query: the only way people and the API talk to an RFQ ----

export interface CustomerReply {
  messageId: string | null;
  at: number;
  text?: string;
  structured?: { decision?: 'accept' | 'decline'; reason?: LossReason; partNumber?: string; quantity?: number; confirmOwnAccount?: boolean; counter?: CounterOffer };
}
/** A counter-offer from a buyer's system (v1 API): the price it wants and any rival claim. */
export interface CounterOffer {
  unitPrice?: number;
  rival?: string;
  rivalGstin?: string;
  rivalPrice?: number;
  attachment?: string;
}
export type SalesSignal = SalesAction & { by: string };
/** `role` sales: the rep deciding after the Finance deadline, on the same figures (never on a claim quote or frozen group). */
export type FinanceSignal =
  | { action: 'approve'; unitPrice: number; reason?: string; factIds?: string[]; by: string; role?: 'finance' | 'sales' }
  | { action: 'reject'; reason?: string; by: string; role?: 'finance' | 'sales' };

export const customerReplySignal = defineSignal<[CustomerReply]>('customerReply');
export const salesActionSignal = defineSignal<[SalesSignal]>('salesAction');
export const financeDecisionSignal = defineSignal<[FinanceSignal]>('financeDecision');
export const stockConfirmedSignal = defineSignal<[{ itemCode: string }]>('stockConfirmed');
export const clockSignal = defineSignal<[{ offsetMs: number }]>('clock');
export const stateQuery = defineQuery<QuoteState>('state');

// ---- Activities: agents get the long options (model calls), code activities the short ones ----

type AgentActs = 'intakeAgent' | 'clarificationAgent' | 'financeReferralAgent' | 'declineReader' | 'recordClaim';
const agentActs = proxyActivities<Pick<Activities, AgentActs>>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '2 seconds', backoffCoefficient: 2, maximumAttempts: 3 },
});
const codeActs = proxyActivities<Omit<Activities, AgentActs>>({
  startToCloseTimeout: '15 seconds',
  retry: { initialInterval: '1 second', maximumAttempts: 5 },
});

type Step = 'loop' | 'closed' | 'final';

const TRADE_WORD = { quantity: 'quantity tier', later_date: 'later delivery', fast_payment: 'faster payment' } as const;

/**
 * One RFQ, start to finish (DESIGN.md 6.3). Fixed routing in code; no LLM supervisor. Every wait is
 * a durable condition on the demo clock; the hold and quote validity are durable timers. Agents
 * never set a price, reserve stock or send: those are store transactions behind code activities.
 */
export async function quoteWorkflow(input: QuoteInput): Promise<QuoteState> {
  const { rfqId, quoteRef, account } = input;
  let offsetMs = input.clockOffsetMs;
  const vnow = () => Date.now() + offsetMs;
  const requestText = input.text !== undefined ? (input.subject ? `${input.subject}\n${input.text}` : input.text) : (input.seed?.requestText ?? (input.request !== undefined ? JSON.stringify(input.request) : null));

  const state: QuoteState = {
    rfqId,
    quoteRef,
    workflowId: input.workflowId ?? rfqId.toLowerCase(),
    account,
    channel: input.channel,
    receivedAt: input.receivedAt,
    caller: input.caller ?? null,
    createdBy: input.createdBy ?? null,
    status: 'intake',
    salesNeed: null,
    closedReason: null,
    final: false,
    draftVersion: 1,
    revision: 0,
    requestText: input.seed?.requestText ?? requestText,
    request: null,
    clarifications: [],
    item: null,
    quantity: null,
    price: null,
    salesPrice: null,
    approval: null,
    finance: null,
    hold: null,
    delivery: null,
    deliveryOffer: null,
    deliveryOptions: [],
    chosenDelivery: null,
    question: null,
    questionMessageId: null,
    customerReply: null,
    sent: null,
    order: null,
    loss: null,
    lateAcceptAt: null,
    firstUnitPrice: null,
    blockedReason: null,
    needsSalesReason: null,
    autoSend: false,
    reopened: false,
    acked: input.seed?.skipAck ?? false,
    injection: null,
    claim: null,
    priceLocked: null,
    counters: 0,
    paymentDays: null,
    holdLimited: null,
    acceptedIndicativeAt: null,
    stockReadAt: null,
    model: null,
    usage: { calls: 0, input: 0, output: 0, reasoning: 0, aiInr: 0, capped: false, smallOrder: false },
    compute: { activities: 0, signals: 0, timers: 0 },
    trace: [...(input.seed?.trace ?? [])],
    updatedAt: input.receivedAt,
  };

  // Count every activity for the compute estimate (section 13).
  const count = <T extends object>(p: T): T =>
    new Proxy(p, {
      get(t, k) {
        const f = (t as Record<string | symbol, unknown>)[k] as (...a: unknown[]) => unknown;
        return (...a: unknown[]) => {
          state.compute.activities += 1;
          return f(...a);
        };
      },
    });
  const A = count(codeActs);
  const G = count(agentActs);

  // Signal slots. Read through functions so TypeScript does not narrow them across awaits.
  const slots: { reply: CustomerReply | null; sales: SalesSignal | null; finance: FinanceSignal | null; stockOk: boolean } = { reply: null, sales: null, finance: null, stockOk: false };
  /** Rival claims found in replies that arrived while no phase reads replies (for example during the Finance wait). */
  const replyClaims: string[] = [];
  const takeReply = (): CustomerReply => {
    const r = slots.reply!;
    slots.reply = null;
    return r;
  };
  const takeSales = (): SalesSignal => {
    const a = slots.sales!;
    slots.sales = null;
    return a;
  };
  const takeFinance = (): FinanceSignal => {
    const d = slots.finance!;
    slots.finance = null;
    return d;
  };
  const hasReply = () => slots.reply !== null;
  const hasSales = () => slots.sales !== null;
  let dirty = false;

  const salesAllowed = (t: SalesAction['type']): boolean => {
    switch (state.status) {
      case 'awaiting_sales':
        return state.salesNeed === 'manual' ? t === 'change' || t === 'question' : ['send', 'change', 'question', 'ask_inventory', 'reserve'].includes(t);
      case 'blocked':
      case 'finance_rejected':
      case 'awaiting_inventory':
        return t === 'change' || t === 'question';
      case 'sent':
        return t === 'change' || t === 'question' || t === 'reserve';
      case 'expired':
        return t === 'reserve';
      case 'lost':
        return t === 'reopen' || t === 'tag_loss';
      default:
        return false;
    }
  };

  setHandler(stateQuery, () => state);
  setHandler(clockSignal, ({ offsetMs: o }) => {
    state.compute.signals += 1;
    offsetMs = o;
  });
  setHandler(customerReplySignal, (r) => {
    state.compute.signals += 1;
    if (state.final) return;
    if (state.status === 'needs_customer' || state.status === 'sent' || state.status === 'expired') {
      slots.reply = r;
      return;
    }
    // A reply in any other state is kept for Sales; no agent runs. A rival claim in it is logged (item 16).
    if (r.text) {
      state.customerReply = { text: r.text, at: r.at };
      if (rivalClaimIn(r.text)) replyClaims.push(r.text);
      dirty = true;
    }
  });
  setHandler(salesActionSignal, (a) => {
    state.compute.signals += 1;
    if (!state.final && salesAllowed(a.type)) slots.sales = a;
  });
  setHandler(financeDecisionSignal, (d) => {
    state.compute.signals += 1;
    if (state.status !== 'awaiting_finance' || !state.finance) return;
    // The rep decides only after the deadline, and never on a claim quote or a frozen group.
    if (d.role === 'sales' && (!state.finance.repMayDecide || state.finance.standingPriceOnly)) return;
    slots.finance = d;
  });
  setHandler(stockConfirmedSignal, ({ itemCode }) => {
    state.compute.signals += 1;
    if (state.status === 'awaiting_inventory' && state.item?.itemCode === itemCode) slots.stockOk = true;
  });

  // ---- Helpers ----

  const trace = (kind: TraceStep['kind'], title: string, note: string, text: string, meta?: AgentMeta) => {
    state.trace.push({
      at: vnow(),
      kind,
      title,
      note,
      text,
      ...(meta && meta.model !== 'template' && { model: meta.model, promptVersion: meta.promptVersion }),
      ...(meta?.fallback && { fallback: true }),
    });
  };
  const publish = async () => {
    state.updatedAt = vnow();
    await A.publish(state, vnow());
  };
  const setStatus = async (s: Status) => {
    state.status = s;
    await publish();
  };
  const holdLive = () => state.hold !== null && state.hold.live;

  /** Wait for `pred` until `deadline` (demo clock). A live hold always ends at its expiry, whatever the wait. */
  async function waitFor(pred: () => boolean, deadline: number): Promise<boolean> {
    for (;;) {
      const until = holdLive() ? Math.min(deadline, state.hold!.expiresAt) : deadline;
      state.compute.timers += 1;
      await condition(() => pred() || dirty || vnow() >= until, Math.max(1, until - vnow()));
      if (pred()) return true;
      if (dirty) {
        dirty = false;
        while (replyClaims.length) await claimFromText(replyClaims.shift()!);
        await publish();
        continue;
      }
      if (holdLive() && vnow() >= state.hold!.expiresAt) {
        await A.expireHold(rfqId, vnow());
        state.hold!.live = false;
        if (state.status === 'awaiting_sales' && state.salesNeed !== 'short') state.salesNeed = 'hold_expired';
        trace('timer', 'Timer', 'Stock hold expired', `The 10-minute reservation ended at ${fmtTime(state.hold!.expiresAt)}.`);
        await publish();
        continue;
      }
      if (vnow() >= deadline) return false;
    }
  }

  async function applyTotals(t: Totals) {
    Object.assign(state.usage, { calls: t.calls, input: t.input, output: t.output, reasoning: t.reasoning, aiInr: t.aiInr });
    if (!state.usage.capped && t.input + t.output >= BUDGET.tokenCapPerRfq) {
      state.usage.capped = true;
      await A.record(rfqId, 'ai_budget_reached', { tokens: t.input + t.output, cap: BUDGET.tokenCapPerRfq, aiInr: Math.round(t.aiInr * 100) / 100 }, { actor: 'rules' }, vnow());
      trace('code', 'Rules', 'AI budget reached', `${t.input + t.output} tokens used of ${BUDGET.tokenCapPerRfq}. No more agent steps; Sales takes over.`);
    }
  }

  const agentMeta = (m: AgentMeta) => {
    if (m.model !== 'template') state.model ??= m.model;
  };

  let req: RfqRequest = { ...EMPTY_REQUEST };
  const agentText = () => requestText ?? '';
  /** H1: the trades on this request. Lead days count from the day the request came in, so a price does not drift while it waits. */
  const tradeIn = (): TradeInputs => ({ leadDays: leadDaysOf(req.deliverBy, istDate(state.receivedAt)), paymentDays: state.paymentDays ?? null });
  /** A2: the last send went out without held stock (indicative): an acceptance runs again as a firm request. */
  let sentIndicative = false;
  /** A2: the buyer was told their acceptance could not be booked (once per acceptance). */
  let acceptTold = false;
  /** A rival claim waiting for the item to be known (logged after the next rules check). */
  let pendingClaim: { c: NonNullable<QuoteInput['claim']>; source: 'rfq_text' | 'reply_text' | 'api' | 'attachment' } | null = null;

  /** Intake agent with budget, cheap-path model and fallback. 'manual' when the AI budget is used up. */
  async function runIntake(): Promise<RfqRequest | 'manual'> {
    if (state.usage.capped) return 'manual';
    try {
      const r = await G.intakeAgent(rfqId, { text: agentText(), clarifications: state.clarifications, small: state.usage.smallOrder, account }, vnow());
      await applyTotals(r.totals);
      agentMeta(r.meta);
      const o = r.output;
      const found = o.partNumber ?? (o.partDescription ? `ambiguous part "${o.partDescription}"` : 'no part');
      trace('agent', 'Intake agent', 'Extracted fields', `${found}${o.quantity ? `, ${o.quantity} units` : ''}${o.firm ? ', firm' : ''}${o.requestedUnitPrice ? `, asked ${inr(o.requestedUnitPrice)}` : ''}.`, r.meta);
      return o;
    } catch {
      await applyTotals(await A.aiTotals(rfqId));
      // The activity refuses to call a model once the budget is used up (no retry runs past the cap).
      if (state.usage.capped) return 'manual';
      await A.record(rfqId, 'extracted', { ...EMPTY_REQUEST, fallback: true }, { actor: 'intake-agent' }, vnow());
      trace('agent', 'Intake agent', 'Extracted fields', 'The model failed three times; code carries on with empty fields.', { actor: 'intake-agent', model: 'unknown', promptVersion: 'intake@3', fallback: true });
      return { ...EMPTY_REQUEST };
    }
  }

  /** A question from Sales (or after a clarification) and the customer's reply. Null on timeout. */
  async function askCustomer(text: string, by: string): Promise<CustomerReply | null> {
    const id = await A.notify(rfqId, account, { kind: 'question', topic: 'sales', text, by: { actor: 'sales' } }, vnow());
    await A.record(rfqId, 'sales_question', { text, user: by }, { actor: 'sales' }, vnow());
    trace('human', 'Sales rep', 'Asked customer', text);
    state.question = { text, by: 'sales', at: vnow() };
    state.questionMessageId = id;
    state.customerReply = null;
    slots.reply = null;
    const back = state.status;
    await setStatus('needs_customer');
    const got = await waitFor(hasReply, vnow() + WAITS.customer);
    if (!got) return null;
    const r = takeReply();
    await A.record(rfqId, 'customer_reply', { text: r.text ?? null, structured: r.structured ?? null }, { actor: 'customer' }, vnow());
    trace('human', 'Buyer', 'Reply signal', r.text ?? JSON.stringify(r.structured ?? {}));
    await claimFromText(r.text);
    state.question = null;
    if (r.text) state.customerReply = { text: r.text, at: r.at };
    state.status = back;
    return r;
  }

  function mergeStructured(s: NonNullable<CustomerReply['structured']>) {
    if (s.confirmOwnAccount) req = { ...req, account: null };
    if (s.partNumber) req = { ...req, partNumber: s.partNumber, partDescription: null };
    if (s.quantity) req = { ...req, quantity: s.quantity };
  }

  function applyChange(a: Extract<SalesSignal, { type: 'change' }>) {
    const qtyChanged = a.quantity !== undefined && a.quantity !== req.quantity;
    const priceChanged = a.unitPrice !== undefined && a.unitPrice !== state.price?.target;
    req = {
      ...req,
      account: null, // Sales acts for the signed-in account; the quote always goes to it
      ...(a.quantity !== undefined && { quantity: a.quantity }),
      ...(a.deliverBy !== undefined && { deliverBy: a.deliverBy }),
      ...(a.itemCode && { partNumber: a.itemCode, partDescription: null }),
    };
    if (a.unitPrice !== undefined) state.salesPrice = a.unitPrice;
    if (qtyChanged || priceChanged || a.itemCode) state.approval = null;
    state.request = req;
    state.draftVersion += 1;
    state.autoSend = false;
    state.chosenDelivery = null;
    state.customerReply = null;
    state.needsSalesReason = null;
    state.reopened = false;
  }

  async function salesChange(a: Extract<SalesSignal, { type: 'change' }>) {
    salesReason = a.reason;
    // The rep's year-volume commitment is recorded only now that the workflow has taken the change.
    const commitItem = a.itemCode ?? state.item?.itemCode ?? null;
    if (a.commitAnnualQty && commitItem) await A.addCommitment({ account, itemCode: commitItem, annualQty: a.commitAnnualQty, rep: a.by, rfqId }, vnow());
    if (holdLive()) {
      await A.releaseReservations(rfqId, 'released', vnow());
      state.hold!.live = false;
    }
    await A.record(rfqId, 'sales_change', { quantity: a.quantity ?? null, unitPrice: a.unitPrice ?? null, deliverBy: a.deliverBy ?? null, itemCode: a.itemCode ?? null, reason: a.reason, user: a.by }, { actor: 'sales' }, vnow());
    trace('human', 'Sales rep', 'Changed', `${a.quantity ? `Quantity ${a.quantity}. ` : ''}${a.unitPrice ? `Price ${inr(a.unitPrice)}. ` : ''}${a.itemCode ? `Item ${a.itemCode}. ` : ''}Reason: ${a.reason}`);
    applyChange(a);
  }

  // ---- Phases ----

  async function rules(): Promise<Evaluation> {
    state.request = req;
    await setStatus('checking');
    const ev = await A.evaluate(rfqId, account, req, state.approval, state.salesPrice, vnow(), state.priceLocked, standing, tradeIn());
    state.item = ev.kind === 'clarify' ? null : ev.item;
    state.quantity = ev.kind === 'clarify' ? req.quantity : ev.kind === 'blocked' && ev.reason === 'NO_CONTRACT_PRICE' ? ev.quantity : ev.price.quantity;
    state.price = ev.kind === 'ok' || ev.kind === 'finance' || (ev.kind === 'blocked' && ev.reason === 'BELOW_MAX_DISCOUNT') ? ev.price : null;
    state.blockedReason = ev.kind === 'blocked' ? ev.reason : null;
    if (state.price) state.usage.smallOrder = state.price.smallOrder;
    // A Sales-typed price below the minimum on a small order was repriced by code: never send a price
    // the rep did not type without the rep seeing it first.
    if (state.price?.targetSource === 'small_order' && state.salesPrice !== null && state.autoSend) {
      state.autoSend = false;
      trace('code', 'Rules', 'Small order repriced', `Quoted at the minimum ${inr(state.price.target)}, not ${inr(state.salesPrice)}. Sales reviews before sending.`);
    }
    if (ev.kind === 'clarify') trace('code', 'Rules', 'Checked request', `Needs the ${ev.reason} from the customer.`);
    else if (ev.kind === 'blocked' && ev.reason === 'NO_CONTRACT_PRICE') trace('code', 'Rules', 'Price and margin check', `No contract price for ${ev.item.itemCode}.`);
    else {
      const p = ev.price;
      const m = marginPct(p.target, p.unitCost);
      const note = ev.kind === 'ok' ? 'pass' : ev.kind === 'finance' ? 'to Finance' : 'blocked';
      const tail =
        ev.kind === 'ok'
          ? `margin ${m.toFixed(1)}% ≥ ${p.minMarginPct}%${p.targetSource === 'trade' ? `. Published trade price: ${p.trades.map((t) => TRADE_WORD[t.kind]).join(', ')}` : ''}${p.targetSource === 'small_order' ? (p.target === p.minPrice ? '. Small order: quoted at the minimum price, no Finance referral' : '. Small order: the asked price is not used, no Finance referral') : p.targetSource === 'finance' ? '. Finance approved this price' : p.targetSource === 'cached' ? '. Same as the live quote for this request' : ''}${p.frozen && p.targetSource !== 'finance' ? '. Discounts frozen or standing price: no new discount' : ''}.`
          : ev.kind === 'finance'
            ? state.priceLocked !== null && p.target < state.priceLocked && m >= p.minMarginPct
              ? `${inr(p.target)} is below the sent price ${inr(state.priceLocked)}. A sent price changes only with Finance.`
              : `asked ${inr(p.target)} gives ${m.toFixed(1)}%, below ${p.minMarginPct}%. Finance decides.`
            : `asked ${inr(p.target)} is below the lowest price anyone can approve.`;
      trace('code', 'Rules', `Price and margin check · ${note}`, `Contract price ${inr(p.contractPrice)}, cost ${inr(p.unitCost)}, ${tail}`);
    }
    return ev;
  }

  let clarifications = 0;
  const askedFor: Partial<Record<Extract<Evaluation, { kind: 'clarify' }>['reason'], number>> = {};

  async function clarify(ev: Extract<Evaluation, { kind: 'clarify' }>): Promise<'loop' | 'manual' | 'closed'> {
    const small = state.usage.smallOrder;
    if (state.usage.capped) {
      state.needsSalesReason = 'AI_BUDGET';
      return 'manual';
    }
    if (small && clarifications >= BUDGET.smallOrderClarifications) {
      state.needsSalesReason = 'SMALL_ORDER';
      return 'manual';
    }
    // The same question answered twice without settling it: a person reads the request (no endless loop).
    if ((askedFor[ev.reason] ?? 0) >= BUDGET.sameQuestionMax) {
      state.needsSalesReason = 'UNCLEAR';
      return 'manual';
    }
    askedFor[ev.reason] = (askedFor[ev.reason] ?? 0) + 1;
    clarifications += 1;
    const r = await G.clarificationAgent(rfqId, account, { reason: ev.reason, options: ev.options, quantity: req.quantity }, small, vnow());
    await applyTotals(r.totals);
    agentMeta(r.meta);
    const q = r.output.question;
    const id = await A.notify(rfqId, account, { kind: 'question', topic: ev.reason, text: q, by: { actor: r.meta.actor, model: r.meta.model, promptVersion: r.meta.promptVersion } }, vnow());
    trace(small ? 'code' : 'agent', small ? 'Template' : 'Clarification agent', 'Asked buyer', q, r.meta);
    state.question = { text: q, by: 'agent', at: vnow() };
    state.questionMessageId = id;
    slots.reply = null;
    await setStatus('needs_customer');
    const got = await waitFor(hasReply, vnow() + WAITS.customer);
    if (!got) return 'closed';
    const rr = takeReply();
    await A.record(rfqId, 'customer_reply', { text: rr.text ?? null, structured: rr.structured ?? null }, { actor: 'customer' }, vnow());
    trace('human', 'Buyer', 'Reply signal', rr.text ?? JSON.stringify(rr.structured ?? {}));
    await claimFromText(rr.text);
    state.question = null;
    if (rr.structured && (rr.structured.partNumber || rr.structured.quantity || rr.structured.confirmOwnAccount)) {
      mergeStructured(rr.structured);
      return 'loop';
    }
    state.clarifications.push({ question: q, reply: rr.text ?? '' });
    const out = await runIntake();
    if (out === 'manual') {
      state.customerReply = { text: rr.text ?? '', at: rr.at };
      state.needsSalesReason = 'AI_BUDGET';
      return 'manual';
    }
    req = out;
    return 'loop';
  }

  /** Section 13: the AI budget is used up, or a small order needs a person. Sales reads the request. */
  async function manual(): Promise<'loop' | 'closed'> {
    state.salesNeed = 'manual';
    state.status = 'awaiting_sales';
    await A.record(rfqId, 'needs_sales', { reason: state.needsSalesReason, tokens: state.usage.input + state.usage.output }, { actor: 'rules' }, vnow());
    trace('code', 'Rules', 'Sent to Sales', state.needsSalesReason === 'AI_BUDGET' ? 'AI budget for this request is used up.' : state.needsSalesReason === 'UNCLEAR' ? 'The customer answered the same question twice without settling it.' : 'Small order: no second question by the agents.');
    for (;;) {
      await publish();
      const deadline = vnow() + WAITS.sales;
      const got = await waitFor(hasSales, deadline);
      if (!got) return 'closed';
      const a = takeSales();
      if (a.type === 'change') {
        await salesChange(a);
        return 'loop';
      }
      if (a.type === 'question') {
        const r = await askCustomer(a.text, a.by);
        if (!r) return 'closed';
        if (r.structured && (r.structured.partNumber || r.structured.quantity || r.structured.confirmOwnAccount)) {
          mergeStructured(r.structured);
          state.needsSalesReason = null;
          return 'loop';
        }
      }
    }
  }

  /** blocked / finance_rejected: Sales may change the quote or ask the customer. */
  async function salesFix(): Promise<Step> {
    const deadline = vnow() + WAITS.sales;
    for (;;) {
      const got = await waitFor(hasSales, deadline);
      if (!got) return 'final';
      const a = takeSales();
      if (a.type === 'change') {
        await salesChange(a);
        return 'loop';
      }
      if (a.type === 'question') {
        const r = await askCustomer(a.text, a.by);
        if (!r) return 'final';
        await publish();
      }
    }
  }

  async function blocked(ev: Extract<Evaluation, { kind: 'blocked' }>): Promise<Step | 'closed'> {
    // The customer gets the same acknowledgement as for any price request: an instant refusal below
    // the max discount would tell a probing buyer where the floor is (DECISIONS 11).
    if (ev.reason === 'BELOW_MAX_DISCOUNT') await ack(ev.price.quantity, ev.price.itemCode);
    await setStatus('blocked');
    const r = await salesFix();
    if (r !== 'final') return r;
    // Nobody acted: the customer gets the one-price reply Finance's refusal sends, and the RFQ closes.
    if (ev.reason === 'BELOW_MAX_DISCOUNT') await refuse(ev.price);
    return 'closed';
  }

  /** The first reply to a request. Any request that names a price gets the same words whatever its band (DECISIONS 11). */
  async function ack(quantity: number, item: string, short?: ShortFacts) {
    if (state.acked) return;
    if (req.requestedUnitPrice !== null) await A.notify(rfqId, account, { kind: 'ack_finance', quantity, item }, vnow());
    else if (short) await A.notify(rfqId, account, { kind: 'ack_short', facts: short }, vnow());
    else await A.notify(rfqId, account, { kind: 'ack_stock', quantity, item }, vnow());
    state.acked = true;
  }

  /** The one-price refusal: the standing price (the sent price, else the contract price), never the asked one. */
  async function refuse(p: { itemCode: string; contractPrice: number; quantity: number }) {
    await A.notify(rfqId, account, { kind: 'price_refused', itemCode: p.itemCode, unitPrice: state.priceLocked ?? p.contractPrice, quantity: p.quantity }, vnow());
  }

  /** Item 16, read at decision time: a claim on this RFQ, or the buyer group frozen now. */
  async function standingNow(): Promise<boolean> {
    return state.claim !== null || (await A.isFrozen(account, vnow()));
  }

  /** Standing price only: a Finance timeout on a claim quote or a frozen group (ADVERSARIAL 16). */
  let standing = false;
  /** The reason the rep gave with the last price change or reopen: shown to Finance with the case. */
  let salesReason: string | null = null;

  async function financeCase(ev: Extract<Evaluation, { kind: 'finance' }>): Promise<Step> {
    const p = ev.price;
    const requestedBy = p.targetSource === 'sales' ? 'sales' : 'customer';
    await ack(p.quantity, p.itemCode);
    const capped = state.usage.capped;
    const seeded = input.seed?.referral === true;
    const r = await G.financeReferralAgent(rfqId, account, p, requestedBy, req.priceReason, seeded, capped, vnow());
    await applyTotals(r.totals);
    agentMeta(r.meta);
    const ref = r.output;
    if (!seeded) trace(capped ? 'code' : 'agent', capped ? 'Template' : 'Finance referral agent', 'Drafted case', ref.summary.map((c) => c.text).join(' '), r.meta);
    const askedAt = vnow();
    const deadlineAt = addBusinessHours(askedAt, POLICY.financeDeadlineBusinessHours);
    const standingPriceOnly = p.frozen || (await standingNow());
    state.finance = {
      status: 'waiting',
      requestedUnitPrice: p.target,
      requestedBy,
      priceReason: req.priceReason,
      approvedUnitPrice: null,
      reason: null,
      askedAt,
      decidedAt: null,
      decidedBy: null,
      decidedByRole: null,
      factIds: [],
      insufficientData: false,
      outcome: null,
      deadlineAt,
      repMayDecide: false,
      standingPriceOnly,
      salesReason: requestedBy === 'sales' ? salesReason : null,
      referral: {
        facts: ref.facts,
        factList: ref.factList,
        dataStatus: ref.dataStatus,
        missing: ref.missing,
        summary: ref.summary,
        considerations: ref.considerations,
        model: r.meta.model === 'template' || r.meta.model === 'seed' ? null : r.meta.model,
        promptVersion: r.meta.promptVersion,
        fallback: r.meta.fallback ?? false,
      },
    };
    slots.finance = null;
    await A.record(rfqId, 'approval_pending', { waitingOn: 'finance', requestedUnitPrice: p.target, requestedBy, deadlineAt, standingPriceOnly, dataStatus: ref.dataStatus }, { actor: 'sales' }, vnow());
    await setStatus('awaiting_finance');
    let deadline = deadlineAt;
    for (;;) {
      const got = await waitFor(() => slots.finance !== null, deadline);
      if (!got) {
        if (!state.finance!.repMayDecide) {
          // Item 16 is read now, not when the case opened: a claim made or a freeze reached during the wait counts.
          const standingOnly = state.finance!.standingPriceOnly || (await standingNow());
          state.finance!.standingPriceOnly = standingOnly;
          if (standingOnly) {
            // A claim quote or a frozen group: the timeout keeps the standing price and the rep cannot decide.
            Object.assign(state.finance!, { status: 'timed_out', decidedAt: vnow(), outcome: 'with_sales' });
            standing = true;
            state.salesPrice = null;
            state.autoSend = false; // Sales reviews the standing price before anything goes out
            const standingPrice = state.priceLocked ?? p.contractPrice;
            await A.record(rfqId, 'finance_deadline_passed', { deadlineAt, fallback: 'standing_price', claim: state.claim !== null, standingPrice }, { actor: 'timer' }, vnow());
            trace('timer', 'Timer', 'Finance deadline passed', `No decision in ${POLICY.financeDeadlineBusinessHours} business hours. The standing price ${inr(standingPrice)} holds; the rep cannot decide this one.`);
            return 'loop';
          }
          state.finance!.repMayDecide = true;
          await A.record(rfqId, 'finance_deadline_passed', { deadlineAt, fallback: 'sales_rep' }, { actor: 'timer' }, vnow());
          trace('timer', 'Timer', 'Finance deadline passed', `No decision in ${POLICY.financeDeadlineBusinessHours} business hours. The sales rep decides on the same figures.`);
          await publish();
          deadline = vnow() + WAITS.sales;
          continue;
        }
        return 'closed';
      }
      const d = takeFinance();
      const role = d.role ?? 'finance';
      const fs = state.finance!;
      if (role === 'sales' && (await standingNow())) {
        // The group was frozen, or a claim arrived, after the deadline: only Finance decides now.
        fs.standingPriceOnly = true;
        await A.record(rfqId, 'finance_signal_ignored', { code: 'FINANCE_ONLY', user: d.by, role }, { actor: 'rules' }, vnow());
        await publish();
        continue;
      }
      if (d.action === 'approve') {
        const rule = fs.referral ? ruleInputsOf(fs.referral.facts) : null;
        let bad = checkFinancePrice(d.unitPrice, d.reason, p, rule);
        if (!bad && d.unitPrice < p.contractPrice) bad = checkReasonCites(d.factIds, fs.referral?.factList ?? []);
        const insufficient = fs.referral?.dataStatus === 'insufficient';
        if (!bad && insufficient && (d.reason ?? '').trim().length < 3) bad = { code: 'REASON_REQUIRED', error: 'The case is missing data: give a written reason' };
        if (bad) {
          // A decision outside the rules is ignored whatever sent it; the wait continues.
          await A.record(rfqId, 'finance_signal_ignored', { unitPrice: d.unitPrice, code: bad.code, user: d.by, role }, { actor: 'rules' }, vnow());
          continue;
        }
        const reason = d.reason?.trim() || null;
        const factIds = d.unitPrice < p.contractPrice ? (d.factIds ?? []) : [];
        state.approval = { itemCode: p.itemCode, quantity: p.quantity, unitPrice: d.unitPrice, reason, at: vnow(), by: d.by };
        Object.assign(fs, { status: 'approved', approvedUnitPrice: d.unitPrice, reason, decidedAt: vnow(), decidedBy: d.by, decidedByRole: role, factIds, insufficientData: insufficient, outcome: 'checking' });
        state.autoSend = true;
        await A.record(rfqId, 'finance_decision', { action: 'approve', unitPrice: d.unitPrice, reason, factIds, insufficientData: insufficient, role, user: d.by }, { actor: role === 'sales' ? 'sales' : 'finance' }, vnow());
        trace('human', role === 'sales' ? 'Sales rep (after Finance deadline)' : 'Finance', `Approved ${inr(d.unitPrice)}`, `${reason ? `Reason: ${reason}` : 'Approved.'}${factIds.length ? ` Cites ${factIds.join(', ')}.` : ''}${insufficient ? ' Approved with missing data.' : ''}`);
        return 'loop';
      }
      Object.assign(fs, { status: 'rejected', decidedAt: vnow(), decidedBy: d.by, decidedByRole: role, reason: d.reason?.trim() || null });
      await A.record(rfqId, 'finance_decision', { action: 'reject', reason: d.reason ?? null, role, user: d.by }, { actor: role === 'sales' ? 'sales' : 'finance' }, vnow());
      trace('human', role === 'sales' ? 'Sales rep (after Finance deadline)' : 'Finance', 'Rejected', `Rejected ${inr(p.target)} each.`);
      // Only the customer's own ask gets a refusal. A revision Sales proposed was never shown to the
      // customer, so nothing goes out: the sent quote stands, or Sales follows up.
      if (requestedBy === 'customer') await refuse(p);
      await setStatus('finance_rejected');
      return salesFix();
    }
  }

  /** Firm only: hold stock on hand, or build the split/full offer against a PO. */
  async function stock(ev: Extract<Evaluation, { kind: 'ok' }>) {
    const qty = ev.price.quantity;
    const item = ev.item;
    state.deliveryOffer = null;
    state.deliveryOptions = [];
    state.holdLimited = null;
    if (!req.firm) {
      state.delivery = stockOption(qty, req.deliverBy, vnow());
      state.salesNeed = 'review';
      state.hold = null;
      return;
    }
    let sc = await A.stockCheck(rfqId, item.itemCode, qty, req.deliverBy, vnow());
    if (sc.enough) {
      const h = await A.placeHold(rfqId, item.itemCode, qty, vnow());
      state.delivery = stockOption(qty, req.deliverBy, vnow());
      if (h.ok) {
        state.hold = { quantity: qty, expiresAt: h.expiresAt, live: true };
        state.stockReadAt = h.countedAt;
        state.salesNeed = 'review';
        trace('code', 'Rules', 'Stock hold committed, timer set', `${qty} of ${h.onHand} held at ${h.location} until ${fmtTime(h.expiresAt)}. Idempotency key ${rfqId}.`);
        return;
      }
      if (h.reason === 'STALE_STOCK') {
        state.hold = null;
        state.salesNeed = 'stale';
        trace('code', 'Rules', 'Stock check · old count', `The ${item.itemCode} count at ${item.location} is more than 5 minutes old and the feed is down.`);
        return;
      }
      if (h.reason === 'HOLD_LIMIT' || h.reason === 'NOT_IN_GOOD_STANDING') {
        // A2: no stock is held for this buyer group now; the quote can still go out, as indicative.
        state.hold = null;
        state.holdLimited = h.reason;
        state.salesNeed = 'review';
        trace('code', 'Rules', 'Stock not held', h.reason === 'HOLD_LIMIT' ? 'The buyer group is at its hold limit. The quote goes out indicative; stock is held when the buyer accepts.' : 'The buyer group is not in good standing. The quote goes out indicative.');
        if (state.acceptedIndicativeAt != null && !acceptTold) {
          // The buyer accepted and stock still cannot be held: tell them once, and Sales sees why.
          acceptTold = true;
          await A.notify(rfqId, account, { kind: 'accept_on_hold', quoteRef }, vnow());
          await A.record(rfqId, 'accept_not_booked', { reason: h.reason }, { actor: 'rules' }, vnow());
          trace('code', 'Rules', 'Acceptance not booked', 'Stock still cannot be held for this buyer. The buyer was told Sales will contact them.');
        }
        return;
      }
      sc = await A.stockCheck(rfqId, item.itemCode, qty, req.deliverBy, vnow()); // lost a race for the last units
    }
    // Short now: an earlier hold of this RFQ is given back (the split offer reserves again at send).
    if (state.hold) await A.releaseReservations(rfqId, 'released', vnow());
    state.hold = null;
    state.salesNeed = 'short';
    state.deliveryOffer = sc.offer;
    state.deliveryOptions = sc.options;
    state.delivery = sc.options.find((o) => o.id === state.chosenDelivery) ?? sc.options[0] ?? null;
    trace('code', 'Rules', 'Stock check · short', `${sc.available} of ${qty} available.${sc.offer?.po ? ` ${sc.offer.po.id} brings ${sc.offer.po.quantity} on ${sc.offer.po.arrivesOn}; ready ${sc.offer.readyOn}.` : ' No purchase order covers it.'}`);
    await ack(qty, item.itemCode, {
      quantity: qty,
      item: item.itemCode,
      requestedDate: req.deliverBy,
      availableNow: sc.available,
      po: sc.offer?.po ? { quantity: sc.offer.po.quantity, arrivesOn: sc.offer.po.arrivesOn } : null,
      readyOn: sc.offer?.readyOn ?? null,
      stockDate: sc.stockDate,
      split: sc.options.some((o) => o.id === 'split'),
    });
  }

  type Review = { send: DeliveryOption } | 'loop' | 'closed' | 'no_reply';

  async function review(): Promise<Review> {
    if (state.autoSend) {
      if (state.salesNeed === 'review' && state.delivery) return { send: state.delivery };
      if (state.salesNeed === 'short' && state.chosenDelivery) {
        const d = state.deliveryOptions.find((o) => o.id === state.chosenDelivery);
        if (d) return { send: d };
      }
      if (state.finance?.status === 'approved') state.finance.outcome = 'with_sales';
    }
    state.status = 'awaiting_sales';
    if (state.price) await ack(state.price.quantity, state.price.itemCode);
    await publish();
    const deadline = vnow() + WAITS.sales;
    for (;;) {
      const got = await waitFor(hasSales, deadline);
      if (!got) return 'closed';
      const a = takeSales();
      switch (a.type) {
        case 'send': {
          const d = state.salesNeed === 'short' ? state.deliveryOptions.find((o) => o.id === a.delivery) : state.delivery;
          if (a.draftVersion !== state.draftVersion || !d) {
            await A.record(rfqId, 'sales_send_ignored', { draftVersion: a.draftVersion, current: state.draftVersion, delivery: a.delivery ?? null, user: a.by }, { actor: 'rules' }, vnow());
            continue;
          }
          await A.record(rfqId, 'sales_send', { draftVersion: a.draftVersion, delivery: d.id, user: a.by }, { actor: 'sales' }, vnow());
          trace('human', 'Sales rep', 'Sent', `Approved draft ${a.draftVersion}${d.id !== 'stock' ? `, delivery ${deliveryText(d, null)}` : ''}.`);
          return { send: d };
        }
        case 'change':
          await salesChange(a);
          return 'loop';
        case 'question': {
          const r = await askCustomer(a.text, a.by);
          if (!r) return 'no_reply';
          await publish();
          continue;
        }
        case 'ask_inventory': {
          slots.stockOk = false;
          await A.record(rfqId, 'asked_inventory', { itemCode: state.item?.itemCode, user: a.by }, { actor: 'sales' }, vnow());
          trace('human', 'Sales rep', 'Asked Operations', `Confirm stock for ${state.item?.itemCode} at ${state.item?.location}.`);
          await setStatus('awaiting_inventory');
          const ok = await waitFor(() => slots.stockOk, vnow() + WAITS.inventory);
          if (ok) {
            trace('human', 'Inventory', 'Count confirmed', `${state.item?.itemCode} count confirmed.`);
            return 'loop';
          }
          await setStatus('awaiting_sales');
          continue;
        }
        case 'reserve':
          await A.record(rfqId, 'sales_reserve', { user: a.by }, { actor: 'sales' }, vnow());
          trace('human', 'Sales rep', 'Reserved again', 'Stock check runs again.');
          return 'loop';
        default:
          continue;
      }
    }
  }

  async function send(d: DeliveryOption): Promise<'sent' | 'loop' | 'review'> {
    const p = state.price!;
    await setStatus('sending');
    const revision = state.revision + 1;
    const r = await A.issueQuote({
      rfqId,
      quoteRef,
      revision,
      account,
      itemCode: p.itemCode,
      quantity: p.quantity,
      draftPrice: p.target,
      firm: req.firm && !state.holdLimited,
      delivery: d,
      place: req.deliverTo,
      approval: state.approval,
      salesPrice: state.salesPrice,
      askedPrice: standing ? null : req.requestedUnitPrice,
      cachedPrice: p.targetSource === 'cached' ? p.target : null,
      frozen: p.frozen,
      lockedPrice: state.priceLocked,
      deliverBy: req.deliverBy,
      trade: tradeIn(),
      priority: state.counters === 0,
      now: vnow(),
    });
    if (r.kind === 'sent') {
      sentIndicative = !req.firm || !!state.holdLimited;
      state.revision = r.revision;
      state.delivery = d;
      state.sent = { at: r.at, to: r.to, validUntil: r.validUntil, fromStock: r.fromStock, fromPo: r.fromPo, poId: r.poId, unitPrice: p.target, total: p.target * p.quantity, revision: r.revision, messageId: r.messageId };
      state.firstUnitPrice ??= p.target;
      state.acceptedIndicativeAt = null;
      state.priceLocked = p.target; // L1: from now on only Finance lowers this price
      state.approval = null; // single use: an approval never carries to the next revision or quote
      if (state.hold) state.hold.live = false; // the reservation now lasts as long as the quote
      state.customerReply = null;
      state.question = null;
      state.autoSend = false;
      if (state.finance?.status === 'approved') state.finance.outcome = 'sent';
      trace('code', 'Rules', 'Rechecked and sent', `${p.quantity} × ${p.itemCode} at ${inr(p.target)} each, ${inr(p.target * p.quantity)}. Valid until ${fmtTime(r.validUntil)}.`);
      await setStatus('sent');
      return 'sent';
    }
    if (r.kind === 'terms_changed') {
      state.draftVersion += 1;
      state.autoSend = false;
      trace('code', 'Rules', 'Terms changed since the draft', 'Price facts changed; a new draft needs review.');
      return 'loop';
    }
    trace('code', 'Rules', 'Send refused', r.reason);
    if (r.reason === 'STALE_STOCK') {
      state.salesNeed = 'stale';
      return 'review';
    }
    if (r.reason === 'HOLD_EXPIRED') {
      state.salesNeed = 'hold_expired';
      if (state.hold) state.hold.live = false;
      return 'review';
    }
    return 'loop';
  }

  async function readReply(r: CustomerReply): Promise<DeclineOutput & { by: string }> {
    if (r.structured?.decision) return { decision: r.structured.decision, reason: r.structured.decision === 'decline' ? (r.structured.reason ?? null) : null, evidence: null, by: 'customer' };
    const text = r.text ?? '';
    if (state.usage.capped) return codeReading(text, 'AI budget used up');
    try {
      const out = await G.declineReader(rfqId, { quote: { itemCode: state.price!.itemCode, quantity: state.price!.quantity, delivery: state.delivery ? deliveryText(state.delivery, null) : '' }, reply: text }, vnow(), account);
      await applyTotals(out.totals);
      agentMeta(out.meta);
      const o = out.output;
      trace('agent', 'Decline reader', 'Read customer reply', `${o.decision}${o.reason ? `, ${o.reason}` : ''}${out.meta.problem === 'gated' ? ' (gated by code)' : ''}`, out.meta);
      return { ...o, by: 'decline-reader' };
    } catch {
      // The model failed three times, or the activity refused because the budget is used up.
      await applyTotals(await A.aiTotals(rfqId));
      return codeReading(text, state.usage.capped ? 'AI budget used up' : 'Decline reader failed');
    }
  }

  /**
   * No model: code reads only a short, unconditional "We accept." or "We decline.", through the same
   * gate as the decline reader's output. Anything else goes to Sales unread.
   */
  async function codeReading(text: string, why: string): Promise<DeclineOutput & { by: string }> {
    const plain = plainDecision(text);
    const d = plain ? gateDecision({ decision: plain, reason: null, evidence: null }, text) : { decision: 'question' as const, reason: null, evidence: null };
    await A.record(rfqId, 'reply_read', { decision: d.decision, byCode: true, why }, { actor: 'rules' }, vnow());
    if (d.decision === 'question') trace('code', 'Rules', why, 'The reply goes to Sales unread.');
    else trace('code', 'Rules', 'Read customer reply', `${d.decision}: a plain reply, read by code (${why.toLowerCase()}).`);
    return { ...d, by: 'rules' };
  }

  async function lose(r: CustomerReply, d: DeclineOutput & { by: string }, released: { fromStock: number; fromPo: number; poId: string | null }) {
    if (state.sent) await A.markRevision(quoteRef, state.sent.revision, 'declined');
    const taggedBy = d.reason ? (d.by === 'customer' ? 'sales' : 'decline-reader') : null;
    const poArrivesOn = released.poId ? (state.deliveryOffer?.po?.arrivesOn ?? null) : null;
    state.loss = {
      declinedAt: r.at,
      customerWords: r.text ?? '',
      reason: d.reason,
      taggedBy: taggedBy as 'decline-reader' | 'sales' | null,
      releasedFromStock: released.fromStock,
      releasedFromPo: released.fromPo,
      poId: released.poId,
      poArrivesOn,
    };
    await A.recordLoss(rfqId, state.revision, { reason: d.reason, evidence: d.evidence, words: r.text ?? null, taggedBy }, { actor: d.by === 'decline-reader' ? 'decline-reader' : 'customer' }, vnow());
    // The early-delivery line only answers a decline about the date; a price decline gets none.
    await A.notify(rfqId, account, { kind: 'lost_ack', quoteRef, poArrivesOn: d.reason === 'delivery_date' ? poArrivesOn : null }, vnow());
    // Fresh delivery choices for a reopen.
    if (state.price && req.firm) {
      const sc = await A.stockCheck(rfqId, state.price.itemCode, state.price.quantity, req.deliverBy, vnow());
      state.deliveryOffer = sc.enough ? state.deliveryOffer : sc.offer;
      state.deliveryOptions = sc.enough ? [stockOption(state.price.quantity, req.deliverBy, vnow())] : sc.options;
    } else state.deliveryOptions = state.price ? [stockOption(state.price.quantity, req.deliverBy, vnow())] : [];
    state.customerReply = null;
    trace('human', 'Buyer', 'Declined', r.text ?? 'Declined.');
    await setStatus('lost');
  }

  async function lostPhase(): Promise<Step> {
    const deadline = vnow() + WAITS.reopen;
    for (;;) {
      const got = await waitFor(hasSales, deadline);
      if (!got) return 'final';
      const a = takeSales();
      if (a.type === 'tag_loss' && state.loss) {
        state.loss.reason = a.reason;
        state.loss.taggedBy = 'sales';
        await A.recordLoss(rfqId, state.revision, { reason: a.reason, evidence: null, words: null, taggedBy: 'sales' }, { actor: 'sales' }, vnow());
        trace('human', 'Sales rep', 'Tagged loss reason', a.reason);
        await publish();
        continue;
      }
      if (a.type === 'reopen') {
        salesReason = a.reason ?? null;
        await A.probe(rfqId, account, 'reopen', state.item?.itemCode ?? null, vnow());
        state.salesPrice = a.unitPrice;
        state.chosenDelivery = a.delivery;
        state.autoSend = true;
        state.reopened = true;
        state.approval = null;
        state.finance = null;
        state.draftVersion += 1;
        state.customerReply = null;
        const lower = state.priceLocked !== null && a.unitPrice < state.priceLocked;
        await A.record(rfqId, 'reopened', { unitPrice: a.unitPrice, delivery: a.delivery, reason: a.reason ?? null, belowSentPrice: lower, user: a.by }, { actor: 'sales' }, vnow());
        trace('human', 'Sales rep', 'Reopened', `New offer ${inr(a.unitPrice)} each, delivery ${a.delivery}.${lower ? ' Below the sent price: Finance decides.' : ''}${a.reason ? ` Reason: ${a.reason}` : ''}`);
        return 'loop';
      }
    }
  }

  async function expireQuote() {
    await A.releaseReservations(rfqId, 'expired', vnow());
    if (state.sent) await A.markRevision(quoteRef, state.sent.revision, 'expired');
    trace('timer', 'Timer', 'Quote expired, stock released', `Valid until ${fmtTime(state.sent?.validUntil ?? vnow())}.`);
    await setStatus('expired');
  }

  async function expiredPhase(): Promise<Step> {
    const deadline = vnow() + WAITS.sales;
    for (;;) {
      const got = await waitFor(() => hasReply() || hasSales(), deadline);
      if (!got) return 'final';
      if (slots.sales) {
        const a = takeSales();
        if (a.type === 'reserve') {
          state.draftVersion += 1;
          await A.record(rfqId, 'sales_reserve', { user: a.by }, { actor: 'sales' }, vnow());
          trace('human', 'Sales rep', 'Reserved again', 'Stock check runs again.');
          return 'loop';
        }
        continue;
      }
      const r = takeReply();
      await A.record(rfqId, 'customer_reply', { text: r.text ?? null, structured: r.structured ?? null }, { actor: 'customer' }, vnow());
      await claimFromText(r.text);
      const d = await readReply(r);
      if (d.decision === 'accept') await lateAccept(r);
      else if (d.decision === 'decline') {
        await lose(r, d, { fromStock: 0, fromPo: 0, poId: null });
        return lostPhase();
      } else {
        // A counter or question on an expired quote gets the expiry reply; Sales sees the words.
        await A.notify(rfqId, account, { kind: 'quote_expired', quoteRef, validUntil: state.sent!.validUntil }, vnow());
        trace('human', 'Buyer', 'Replied after expiry', r.text ?? '');
        state.customerReply = { text: r.text ?? '', at: r.at, answered: true };
        await publish();
      }
    }
  }

  async function lateAccept(r: CustomerReply) {
    state.lateAcceptAt = r.at;
    await A.notify(rfqId, account, { kind: 'quote_expired', quoteRef, validUntil: state.sent!.validUntil }, vnow());
    trace('human', 'Buyer', 'Tried to accept', `After the quote expired at ${fmtTime(state.sent!.validUntil)}.`);
    await publish();
  }

  async function sentPhase(): Promise<Step> {
    for (;;) {
      const s = state.sent!;
      const got = await waitFor(() => hasReply() || hasSales(), s.validUntil);
      if (!got) {
        await expireQuote();
        return expiredPhase();
      }
      if (slots.sales) {
        const a = takeSales();
        if (vnow() >= s.validUntil) {
          await expireQuote();
          if (a.type === 'reserve') {
            state.draftVersion += 1;
            return 'loop';
          }
          return expiredPhase();
        }
        if (a.type === 'change') {
          await A.releaseReservations(rfqId, 'released', vnow());
          await salesChange(a);
          return 'loop';
        }
        if (a.type === 'question') {
          const id = await A.notify(rfqId, account, { kind: 'question', topic: 'sales', text: a.text, by: { actor: 'sales' } }, vnow());
          trace('human', 'Sales rep', 'Asked customer', a.text);
          state.question = { text: a.text, by: 'sales', at: vnow() };
          state.questionMessageId = id;
          state.customerReply = null;
          await publish();
        }
        continue;
      }
      const r = takeReply();
      await A.record(rfqId, 'customer_reply', { text: r.text ?? null, structured: r.structured ?? null }, { actor: 'customer' }, vnow());
      // A rival claim in any reply is logged, whatever else the reply says (decline, question, counter).
      const c = r.structured?.counter;
      if (!(c && (c.rivalPrice !== undefined || c.attachment || c.rival))) await claimFromText(r.text);
      if (r.structured?.counter) {
        await answerCounter(r);
        continue;
      }
      const d = await readReply(r);
      if (d.decision === 'question' && isCounter(r.text, s.unitPrice)) {
        await answerCounter(r);
        continue;
      }
      if (d.decision === 'accept') {
        if (!req.firm || sentIndicative) {
          // An accepted indicative quote becomes a firm request and runs the loop again.
          req = { ...req, firm: true };
          state.acceptedIndicativeAt = r.at;
          acceptTold = false;
          state.draftVersion += 1;
          trace('human', 'Buyer', 'Accepted indicative quote', 'Runs again as a firm request.');
          return 'loop';
        }
        const b = await A.bookOrder(rfqId, quoteRef, s.revision, vnow(), req.deliverTo);
        if (b.ok) {
          state.order = { ref: b.orderRef, acceptedAt: r.at };
          state.customerReply = null;
          trace('code', 'Rules', 'Order booked', b.orderRef);
          state.final = true;
          await setStatus('ordered');
          return 'final';
        }
        await expireQuote();
        await lateAccept(r);
        return expiredPhase();
      }
      if (d.decision === 'decline') {
        const released = await A.releaseReservations(rfqId, 'released', vnow());
        await lose(r, d, released);
        return lostPhase();
      }
      state.customerReply = { text: r.text ?? '', at: r.at };
      await publish();
    }
  }

  /** A buyer claim, recorded as unverified with its alert. Never changes the price or the reply. */
  async function recordClaim(c: { rival: string | null; rivalGstin: string | null; claimedPrice: number | null; attachmentText: string | null }, source: 'rfq_text' | 'reply_text' | 'api' | 'attachment') {
    const out = await G.recordClaim(rfqId, account, { ...c, source }, { itemCode: state.item?.itemCode ?? req.partNumber, quantity: state.quantity ?? req.quantity, deliverBy: req.deliverBy }, vnow());
    const rank = { no_concern: 0, check: 1, likely_fake: 2 } as const;
    const level = state.claim && rank[state.claim.level] > rank[out.level] ? state.claim.level : out.level;
    state.claim = { count: (state.claim?.count ?? 0) + 1, level, ids: [...(state.claim?.ids ?? []), out.claimId] };
    if (state.finance?.status === 'waiting') state.finance.standingPriceOnly = true; // item 16: a claim quote now
    trace('code', 'Rules', 'Buyer claim logged, unverified', `${c.claimedPrice ? `Claimed rival price ${inr(c.claimedPrice)}. ` : ''}Price unchanged. Finance reviews the alert.`);
  }

  /** Logs a rival price found in customer text as an unverified claim (no-op when there is none or the item is unknown). */
  async function claimFromText(text: string | null | undefined) {
    const t = rivalClaimIn(text);
    if (!t) return;
    if (!state.item && !req.partNumber) {
      pendingClaim ??= { c: { rival: null, rivalGstin: null, claimedPrice: t.price, attachmentText: null }, source: 'reply_text' };
      return;
    }
    await recordClaim({ rival: null, rivalGstin: null, claimedPrice: t.price, attachmentText: null }, 'reply_text');
  }

  /**
   * DECISIONS 11: a counter never moves the price. Code answers with the uniform reply naming the
   * offered price, counts the counter for the buyer group (three in seven days freeze discounts), and
   * logs any rival claim. Sales sees the reply; a lower price needs Finance (L1).
   */
  async function answerCounter(r: CustomerReply) {
    const c = r.structured?.counter;
    // A text claim was logged by the caller; a structured one (v1 counter with rival fields) is logged here.
    if (c && (c.rivalPrice !== undefined || c.attachment || c.rival))
      await recordClaim(
        { rival: c.rival ?? null, rivalGstin: c.rivalGstin ?? null, claimedPrice: c.rivalPrice ?? rivalClaimIn(r.text)?.price ?? null, attachmentText: c.attachment ?? null },
        c.attachment ? 'attachment' : 'api',
      );
    const s = state.sent!;
    const res = await A.counter(rfqId, account, quoteRef, s.unitPrice, state.price!.itemCode, vnow());
    state.counters += 1;
    state.customerReply = { text: r.text ?? (c?.unitPrice ? `Counter-offer ${inr(c.unitPrice)} each.` : 'Counter-offer.'), at: r.at, answered: true };
    trace('code', 'Rules', 'Counter answered', `Uniform reply: offer stands at ${inr(s.unitPrice)}.${res.newlyFrozen ? ' Probe limit reached: discounts frozen for the buyer group.' : ''}`);
    await publish();
  }

  async function close(reason: NonNullable<QuoteState['closedReason']>): Promise<QuoteState> {
    await A.releaseReservations(rfqId, 'released', vnow());
    state.closedReason = reason;
    state.final = true;
    if (state.hold) state.hold.live = false;
    trace('timer', 'Timer', 'Closed', reason === 'NO_CUSTOMER_REPLY' ? 'No reply from the customer.' : reason === 'NO_FINANCE_DECISION' ? 'No decision from Finance.' : 'No decision from Sales.');
    await setStatus('closed');
    return state;
  }

  async function finish(): Promise<QuoteState> {
    state.final = true;
    await publish();
    return state;
  }

  // ---- Start ----

  const injection = detectInjection(requestText);
  state.injection = injection;
  if (!input.seed) {
    await A.record(rfqId, 'rfq_received', { channel: input.channel, account, messageId: input.messageId ?? null, caller: input.caller ? 'logged' : null }, { actor: `channel:${input.channel}` }, input.receivedAt);
    trace('code', input.channel === 'phone' ? 'Phone call' : `${input.channel === 'mail' ? 'Email' : input.channel === 'chat' ? 'Chat' : 'API'} channel`, `RFQ received from ${account}`, rfqId);
    if (injection) {
      await A.record(rfqId, 'injection_flagged', { phrase: injection.phrase }, { actor: 'rules' }, vnow());
      trace('code', 'Rules', 'Instruction-like text ignored', `“${injection.phrase}”. Checks ran unchanged.`);
    }
  }
  await publish();

  if (input.request !== undefined) {
    req = parseStructured(input.request);
    if (!input.seed) trace('code', 'Rules', 'Structured request parsed', 'No agent needed.');
  } else if (input.text !== undefined) {
    const est = await A.estimateValue(agentText());
    state.usage.smallOrder = est !== null && est < BUDGET.smallOrderBelowInr;
    const out = await runIntake();
    req = out === 'manual' ? { ...EMPTY_REQUEST } : out;
  }
  state.request = req;
  // H1: faster payment is a trade the buyer offers on the request (v1 `payment_days`, or "pay in 7 days" in the text).
  {
    const r = (input.request && typeof input.request === 'object' ? input.request : {}) as Record<string, unknown>;
    const pd = r.payment_days ?? r.paymentDays;
    state.paymentDays = typeof pd === 'number' && Number.isInteger(pd) && pd >= 0 && pd <= 365 ? pd : paymentDaysIn(input.text ?? input.seed?.requestText);
  }

  // A rival claim with the request (v1 `rival_claim`, or a rival price in the text) is logged once the item is known.
  // "A competitor offered less" with no figure is a claim too (item 16): it makes this a claim quote.
  const textClaim = rivalClaimIn(input.text ?? input.seed?.requestText);
  pendingClaim = input.claim
    ? { c: input.claim, source: input.claim.attachmentText ? 'attachment' : 'api' }
    : textClaim
      ? { c: { rival: null, rivalGstin: null, claimedPrice: textClaim.price, attachmentText: null }, source: 'rfq_text' }
      : req.priceReason === 'competitor'
        ? { c: { rival: null, rivalGstin: null, claimedPrice: null, attachmentText: null }, source: input.request !== undefined ? 'api' : 'rfq_text' }
        : null;

  main: for (;;) {
    const ev = await rules();
    if (pendingClaim && ev.kind !== 'clarify') {
      const pc = pendingClaim;
      pendingClaim = null;
      await recordClaim(pc.c, pc.source);
    }
    if (ev.kind === 'clarify') {
      const r = await clarify(ev);
      if (r === 'closed') return close('NO_CUSTOMER_REPLY');
      if (r === 'manual' && (await manual()) === 'closed') return close('NO_SALES_DECISION');
      continue;
    }
    if (ev.kind === 'blocked') {
      const r = await blocked(ev);
      if (r === 'closed') return close('NO_SALES_DECISION');
      continue;
    }
    if (ev.kind === 'finance') {
      const r = await financeCase(ev);
      if (r === 'closed') return close('NO_FINANCE_DECISION');
      // Finance said no and Sales did nothing: the refusal (or the sent quote) stands and the RFQ closes.
      if (r === 'final') return close('NO_SALES_DECISION');
      continue;
    }
    await stock(ev);
    for (;;) {
      const rv = await review();
      if (rv === 'loop') continue main;
      if (rv === 'closed') return close('NO_SALES_DECISION');
      if (rv === 'no_reply') return close('NO_CUSTOMER_REPLY');
      const s = await send(rv.send);
      if (s === 'loop') continue main;
      if (s === 'review') continue;
      const after = await sentPhase();
      if (after === 'final') return finish();
      continue main;
    }
  }
}
