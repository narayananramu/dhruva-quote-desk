import { POLICY } from './config';
import type {
  Account,
  AiCallRow,
  AuditRow,
  ClaimView,
  WinRateView,
  CustomerMessage,
  FinanceCase,
  PriceView,
  QuoteDetail,
  QuoteSummary,
  ReservationRow,
  SalesActionType,
  Stage,
  StockRequest,
  StockView,
  UsageView,
} from './contract';
import { expectedProfit, fmtTime, inr, marginPct, type PriceFacts } from './domain';
import { actionsOf, type QuoteState } from './state';
import type { ClaimRow, RfqRow, Store } from './store';
import { pricePerM, stageModel, usageView, type CostConfig } from './usage';

/**
 * Read models for the API (DESIGN.md 8.2). Everything is derived from the workflow's published
 * snapshot plus live stock and the demo clock. Pure reads: nothing here writes.
 */

/** A placeholder until the workflow publishes its first snapshot. */
export function blankState(r: RfqRow): QuoteState {
  return {
    rfqId: r.rfqId,
    quoteRef: r.quoteRef,
    workflowId: r.workflowId,
    account: r.account,
    channel: r.channel,
    receivedAt: r.receivedAt,
    caller: null,
    createdBy: null,
    status: 'intake',
    salesNeed: null,
    closedReason: null,
    final: false,
    draftVersion: 1,
    revision: 0,
    requestText: null,
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
    acked: false,
    injection: null,
    claim: null,
    priceLocked: null,
    counters: 0,
    stockReadAt: null,
    model: null,
    usage: { calls: 0, input: 0, output: 0, reasoning: 0, aiInr: 0, capped: false, smallOrder: false },
    compute: { activities: 0, signals: 0, timers: 0 },
    trace: [],
    updatedAt: r.receivedAt,
  };
}

export const stateOf = (r: RfqRow) => r.state ?? blankState(r);

/** 8.2: workflow status → stage. */
export function stageOf(s: QuoteState, countOld: boolean, now: number): Stage {
  switch (s.status) {
    case 'intake':
    case 'checking':
    case 'sending':
      return 'reading';
    case 'needs_customer':
      return 'needs_customer';
    case 'awaiting_finance':
      return 'with_finance';
    case 'finance_rejected':
    case 'blocked':
      return s.status;
    case 'awaiting_inventory':
      return 'with_inventory';
    case 'awaiting_sales':
      if (s.salesNeed === 'manual') return 'needs_sales';
      if (s.salesNeed === 'short') return 'short';
      if (s.salesNeed === 'hold_expired' || (s.hold !== null && s.hold.expiresAt <= now)) return 'hold_expired';
      if (s.salesNeed === 'stale' || (s.request?.firm !== false && countOld)) return 'stale';
      return 'ready';
    case 'sent':
      return s.sent && s.sent.validUntil <= now ? 'quote_expired' : 'sent';
    case 'expired':
      return 'quote_expired';
    default:
      return s.status;
  }
}

export function actionsFor(stage: Stage, s: QuoteState): SalesActionType[] {
  switch (stage) {
    case 'ready':
      return ['send', 'change', 'question'];
    case 'stale':
      return ['ask_inventory', 'change', 'question'];
    case 'with_inventory':
      return ['change', 'question'];
    case 'hold_expired':
      return ['reserve', 'change', 'question'];
    case 'short':
      return s.deliveryOptions.length ? ['send', 'change', 'question'] : ['change', 'question'];
    case 'finance_rejected':
    case 'blocked':
    case 'needs_sales':
      return ['change', 'question'];
    case 'sent':
      return s.customerReply ? ['question', 'change'] : [];
    case 'quote_expired':
      return ['reserve'];
    case 'lost':
      return s.loss && s.loss.reason === null ? ['reopen', 'tag_loss'] : ['reopen'];
    default:
      return [];
  }
}

export class Views {
  constructor(
    private readonly store: Store,
    private readonly costs: CostConfig,
    /** The configured intake model, priced for the rupee budget before an RFQ has used any model. */
    private readonly defaultModel: string | null = null,
  ) {}

  private acct(code: string): Account {
    const a = this.store.account(code);
    return a ? { code: a.code, name: a.name, email: a.email } : { code, name: code, email: '' };
  }

  stage(s: QuoteState, now: number): Stage {
    const countOld = s.item ? this.store.countOld(s.item.itemCode, now) : false;
    return stageOf(s, countOld, now);
  }

  usage(s: QuoteState): UsageView {
    const p = s.price;
    const gross = p ? (p.target - p.unitCost) * p.quantity : null;
    const model = s.model && s.model !== 'seed' && s.model !== 'unknown' ? s.model : (this.defaultModel ?? stageModel(this.costs));
    return usageView(this.costs, this.store.aiTotals(s.rfqId), actionsOf(s), { capped: s.usage.capped, smallOrder: s.usage.smallOrder }, gross, pricePerM(this.costs, model));
  }

  summary(r: RfqRow, now: number): QuoteSummary {
    const s = stateOf(r);
    const stage = this.stage(s, now);
    // A refused ask is not the quote: the list shows the price that stands (the sent price, else the contract price).
    const unit = s.price ? (stage === 'finance_rejected' || stage === 'blocked' ? (s.priceLocked ?? s.price.contractPrice) : s.price.target) : null;
    return {
      rfqId: s.rfqId,
      quoteRef: s.quoteRef,
      account: this.acct(s.account),
      itemCode: s.item?.itemCode ?? s.request?.partNumber ?? null,
      quantity: s.quantity ?? s.request?.quantity ?? null,
      total: s.price && unit !== null ? unit * s.price.quantity : null,
      stage,
      revision: s.revision,
      needsAnswer: s.customerReply !== null && !s.customerReply.answered,
      receivedAt: s.receivedAt,
      updatedAt: r.updatedAt,
      usage: this.usage(s),
    };
  }

  /** Win rate and expected gross profit at a price, for the item's part group (staff only). */
  winRateView(p: Pick<PriceFacts, 'itemCode' | 'quantity' | 'unitCost' | 'contractPrice'>, price: number, now: number): WinRateView | null {
    const item = this.store.item(p.itemCode);
    if (!item) return null;
    const w = this.store.winRate(item.partGroup, price, p.contractPrice, now);
    return { price, quotes: w.quotes, won: w.won, enough: w.enough, pct: w.pct, lowPct: w.lowPct, highPct: w.highPct, expectedProfit: expectedProfit((price - p.unitCost) * p.quantity, w) };
  }

  private priceView(s: QuoteState, now: number, forSales = false): PriceView | null {
    const p = s.price;
    if (!p) return null;
    return {
      unitPrice: p.target,
      total: p.target * p.quantity,
      contractPrice: p.contractPrice,
      contractTotal: p.contractPrice * p.quantity,
      unitCost: p.unitCost,
      marginPct: marginPct(p.target, p.unitCost),
      profit: (p.target - p.unitCost) * p.quantity,
      minMarginPct: p.minMarginPct,
      minPrice: p.minPrice,
      maxDiscountPct: forSales ? null : p.maxDiscountPct,
      floorPrice: forSales ? null : p.floorPrice,
      band: p.band,
      policyVersion: p.policyVersion,
      winRate: this.winRateView(p, p.target, now),
      winRateAtContract: this.winRateView(p, p.contractPrice, now),
      targetSource: p.targetSource,
      frozen: p.frozen ?? false,
      basePrice: p.basePrice ?? p.contractPrice,
      trades: p.trades ?? [],
    };
  }

  /** The configured model when the RFQ has no model of its own yet (structured or seeded requests). */
  private modelOf(s: QuoteState): string | null {
    return s.model && s.model !== 'seed' && s.model !== 'unknown' ? s.model : this.defaultModel;
  }

  private stockView(s: QuoteState, now: number): StockView | null {
    if (!s.item) return null;
    const r = this.store.stockRow(s.item.itemCode, now);
    const needed = s.quantity ?? 0;
    const own = s.hold?.live ? s.hold.quantity : 0;
    return {
      itemCode: r.itemCode,
      location: r.location,
      onHand: r.onHand,
      reserved: r.reserved,
      ordered: r.ordered,
      available: r.available,
      countedAt: r.countedAt,
      countOld: r.countOld,
      needed,
      enough: r.available + own >= needed,
    };
  }

  /** `forSales`: the rep's view hides the max-discount price (Finance-only) and alert reasons. */
  detail(r: RfqRow, now: number, forSales = false): QuoteDetail {
    const s = stateOf(r);
    const sum = this.summary(r, now);
    const owner = this.store.account(s.account)?.owner ?? 'Priya N.';
    const f = s.finance;
    return {
      ...sum,
      workflowId: s.workflowId,
      channel: s.channel,
      caller: s.caller,
      salesRep: s.createdBy ?? owner,
      draftVersion: s.draftVersion,
      requestText: s.requestText,
      item: s.item ? { code: s.item.itemCode, description: s.item.description, location: s.item.location, clearance: s.item.clearance ?? false } : null,
      newCustomer: this.store.lifetime(s.account).newCustomer,
      wants: {
        firm: s.request?.firm ?? false,
        deliverBy: s.request?.deliverBy ?? null,
        deliverTo: s.request?.deliverTo ?? null,
        unitPrice: s.request?.requestedUnitPrice ?? null,
        priceReason: s.request?.priceReason ?? null,
        paymentDays: s.paymentDays ?? null,
      },
      holdLimited: s.holdLimited ?? null,
      acceptedIndicativeAt: s.acceptedIndicativeAt ?? null,
      stockPriority: (s.counters ?? 0) === 0,
      price: this.priceView(s, now, forSales),
      stock: this.stockView(s, now),
      hold: s.hold ? { quantity: s.hold.quantity, expiresAt: s.hold.expiresAt } : null,
      delivery: s.delivery,
      deliveryOffer: sum.stage === 'short' || sum.stage === 'lost' ? s.deliveryOffer : null,
      deliveryOptions: sum.stage === 'short' || sum.stage === 'lost' ? s.deliveryOptions : [],
      question: s.question,
      customerReply: s.customerReply,
      finance: f
        ? {
            status: f.status,
            requestedUnitPrice: f.requestedUnitPrice,
            requestedBy: f.requestedBy,
            approvedUnitPrice: f.approvedUnitPrice,
            reason: f.reason,
            decidedAt: f.decidedAt,
            deadlineAt: f.deadlineAt ?? f.askedAt,
            repMayDecide: f.repMayDecide ?? false,
            standingPriceOnly: this.standingOnly(s, now),
            decidedByRole: f.decidedByRole ?? null,
          }
        : null,
      claim: s.claim ? { level: s.claim.level, count: s.claim.count } : null,
      frozen: this.store.frozen(s.account, now),
      priceLocked: s.priceLocked ?? null,
      sent: s.sent ? { at: s.sent.at, to: s.sent.to, validUntil: s.sent.validUntil, fromStock: s.sent.fromStock, fromPo: s.sent.fromPo, poId: s.sent.poId, unitPrice: s.sent.unitPrice, total: s.sent.total } : null,
      order: s.order,
      loss: s.loss
        ? {
            declinedAt: s.loss.declinedAt,
            customerWords: s.loss.customerWords,
            reason: s.loss.reason,
            taggedBy: s.loss.taggedBy,
            releasedFromStock: s.loss.releasedFromStock,
            releasedFromPo: s.loss.releasedFromPo,
            poId: s.loss.poId,
          }
        : null,
      lateAcceptAt: s.lateAcceptAt,
      firstUnitPrice: s.firstUnitPrice,
      blockedReason: s.blockedReason,
      needsSalesReason: sum.stage === 'needs_sales' ? s.needsSalesReason : null,
      actions: actionsFor(sum.stage, s),
      technical: {
        model: this.modelOf(s),
        policyVersion: POLICY.version,
        stockReadAt: s.stockReadAt,
        holdExpiresAt: s.hold?.expiresAt ?? null,
        injection: s.injection,
      },
      trace: s.trace,
    };
  }

  /** Item 16, read now: a claim on the RFQ or a frozen group means only Finance decides, whenever it happened. */
  private standingOnly(s: QuoteState, now: number): boolean {
    return (s.finance?.standingPriceOnly ?? false) || s.claim !== null || (s.finance?.status === 'waiting' && this.store.frozen(s.account, now));
  }

  financeCase(r: RfqRow, now: number): FinanceCase | null {
    const s = stateOf(r);
    const f = s.finance;
    const p = s.price;
    if (!f || !p || !s.item) return null;
    const a = this.acct(s.account);
    const outcome = f.status === 'rejected' ? 'with_sales' : (f.outcome ?? 'checking');
    return {
      rfqId: s.rfqId,
      quoteRef: s.quoteRef,
      workflowId: s.workflowId,
      account: a,
      salesRep: s.createdBy ?? this.store.account(s.account)?.owner ?? 'Priya N.',
      item: { code: s.item.itemCode, description: s.item.description, clearance: s.item.clearance ?? false },
      quantity: f.referral?.facts.quantity ?? p.quantity,
      requestedUnitPrice: f.requestedUnitPrice,
      requestedBy: f.requestedBy,
      priceReason: f.priceReason,
      rules: { contractPrice: p.contractPrice, unitCost: p.unitCost, minMarginPct: p.minMarginPct, minPrice: p.minPrice, maxDiscountPct: p.maxDiscountPct, floorPrice: p.floorPrice },
      referral: f.referral
        ? {
            summary: f.referral.summary,
            considerations: f.referral.considerations,
            factList: f.referral.factList,
            dataStatus: f.referral.dataStatus,
            missing: f.referral.missing,
            model: f.referral.model,
            promptVersion: f.referral.promptVersion,
            fallback: f.referral.fallback,
          }
        : null,
      winRate: { atRequested: this.winRateView(p, f.requestedUnitPrice, now)!, atContract: this.winRateView(p, p.contractPrice, now)! },
      claims: this.store.claims({ rfqId: s.rfqId }).map(claimView),
      injection: s.injection,
      history: this.store.history(s.account, now),
      status: f.status,
      deadlineAt: f.deadlineAt,
      repMayDecide: f.repMayDecide,
      standingPriceOnly: this.standingOnly(s, now),
      salesReason: f.salesReason ?? null,
      decision:
        f.status === 'waiting'
          ? null
          : {
              unitPrice: f.approvedUnitPrice,
              reason: f.reason,
              factIds: f.factIds ?? [],
              insufficientData: f.insufficientData ?? false,
              by: f.decidedBy,
              byRole: f.decidedByRole ?? null,
              at: f.decidedAt ?? now,
              outcome,
              sentTo: outcome === 'sent' ? (s.sent?.to ?? null) : null,
              sentAt: outcome === 'sent' ? (s.sent?.at ?? null) : null,
            },
    };
  }

  financeQueue(now: number): FinanceCase[] {
    const cases = this.store
      .rfqs()
      .map((r) => ({ r, c: this.financeCase(r, now) }))
      .filter((x): x is { r: RfqRow; c: FinanceCase } => x.c !== null);
    const waiting = cases.filter((x) => x.c.status === 'waiting').sort((a, b) => (stateOf(a.r).finance!.askedAt - stateOf(b.r).finance!.askedAt));
    const decided = cases.filter((x) => x.c.status !== 'waiting').sort((a, b) => (b.c.decision!.at - a.c.decision!.at));
    return [...waiting, ...decided].map((x) => x.c);
  }

  messages(account: string, now: number): CustomerMessage[] {
    const all = this.store.messagesFor(account);
    const replies = new Map<string, { text: string; at: number }>();
    for (const m of all) if (m.direction === 'in' && m.replyTo) replies.set(m.replyTo, { text: m.text, at: m.at });
    const latestQuote = new Map<string, string>();
    for (const m of all) if (m.kind === 'quote' && m.rfqId) latestQuote.set(m.rfqId, m.id);
    const stages = new Map<string, Stage>();
    const stageFor = (rfqId: string) => {
      if (!stages.has(rfqId)) {
        const r = this.store.rfq(rfqId);
        stages.set(rfqId, r ? this.stage(stateOf(r), now) : 'closed');
      }
      return stages.get(rfqId)!;
    };
    return all.map((m) => {
      const reply = replies.get(m.id) ?? null;
      let canReply = false;
      if (m.direction === 'out' && !reply) {
        if (m.kind === 'question' || m.kind === 'price_refused') canReply = true;
        if (m.kind === 'quote' && m.rfqId && latestQuote.get(m.rfqId) === m.id) canReply = ['sent', 'quote_expired'].includes(stageFor(m.rfqId));
      }
      return { id: m.id, rfqId: m.rfqId, at: m.at, direction: m.direction, kind: m.kind, mail: m.direction === 'in' ? null : m.mail, chat: m.chat, canReply, reply };
    });
  }

  reservations(): ReservationRow[] {
    const groups = new Map<string, ReturnType<Store['reservationRows']>>();
    for (const r of this.store.reservationRows()) {
      const k = `${r.rfqId}/${r.revision ?? `h${r.createdAt}`}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const out: (ReservationRow & { createdAt: number })[] = [];
    for (const rows of groups.values()) {
      const first = rows[0]!;
      const rfq = this.store.rfq(first.rfqId);
      const stock = rows.filter((r) => r.source === 'stock');
      const po = rows.filter((r) => r.source === 'po');
      const status: ReservationRow['status'] = rows.some((r) => r.status === 'active') ? 'held' : rows.every((r) => r.status === 'ordered') ? 'ordered' : 'released';
      out.push({
        rfqId: first.rfqId,
        quoteRef: rfq?.quoteRef ?? '',
        accountName: rfq ? this.acct(rfq.account).name : '',
        itemCode: first.itemCode,
        location: this.store.stockRaw(first.itemCode).location,
        fromStock: stock.reduce((n, r) => n + r.quantity, 0),
        fromPo: po.reduce((n, r) => n + r.quantity, 0),
        poId: po[0]?.poId ?? null,
        until: po.length ? null : first.expiresAt,
        deliverOn: po.length ? [...new Set(rows.map((r) => r.deliverOn).filter((d): d is string => !!d))] : [],
        status,
        createdAt: Math.max(...rows.map((r) => r.createdAt)),
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).map(({ createdAt: _c, ...r }) => r);
  }

  stockRequests(): StockRequest[] {
    return this.store
      .rfqs()
      .map(stateOf)
      .filter((s) => s.status === 'awaiting_inventory' && s.item)
      .map((s) => {
        const st = this.store.stockRaw(s.item!.itemCode);
        const asked = [...s.trace].reverse().find((t) => t.note === 'Asked Operations');
        return { rfqId: s.rfqId, itemCode: s.item!.itemCode, location: st.location, onHand: st.onHand, accountName: this.acct(s.account).name, quantity: s.quantity ?? 0, askedAt: asked?.at ?? s.updatedAt };
      });
  }

  aiCalls(rfqId: string): AiCallRow[] {
    return this.store.aiCalls(rfqId).map((c) => ({
      at: c.at,
      agent: c.agent,
      model: c.model,
      promptVersion: c.promptVersion,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      reasoningTokens: c.reasoningTokens,
      totalTokens: c.inputTokens + c.outputTokens,
      inrPerMTokens: c.inrPerM,
      inr: Math.round(c.inr * 10_000) / 10_000, // to 1/100 paisa: a short call on the open-weight model is not free
      ok: c.ok,
    }));
  }

  /** `forSales`: the rep's audit hides the max-discount price, the facts that state it and the alert reasons (A4). */
  audit(rfqId: string, accountName: string, forSales = false): AuditRow[] {
    return this.store.auditRows(rfqId).map((r) => auditRow(forSales ? { ...r, detail: redactForSales(r.detail) } : r, accountName, rfqId));
  }
}

/** Keys a rep may not read in an audit row: the max discount, and the alert's reasons and document. */
const SALES_HIDDEN_KEYS = new Set(['floorPrice', 'maxDiscountPct', 'signals', 'findings', 'dropped', 'attachmentText']);
/** Fact keys that state the max discount. A statement citing one is hidden from the rep too. */
const SALES_HIDDEN_FACTS = new Set(['discount.maxPct', 'price.maxDiscount']);

/** A copy of an audit detail with everything a rep may not see removed (A4, ADVERSARIAL threat 8). */
export function redactForSales(detail: unknown): unknown {
  const hiddenIds = new Set<string>();
  const collect = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.id === 'string' && typeof o.key === 'string' && SALES_HIDDEN_FACTS.has(o.key)) hiddenIds.add(o.id);
      Object.values(o).forEach(collect);
    }
  };
  collect(detail);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v))
      return v
        .filter((x) => !(x && typeof x === 'object' && ((typeof (x as { key?: unknown }).key === 'string' && SALES_HIDDEN_FACTS.has((x as { key: string }).key)) || (Array.isArray((x as { cites?: unknown }).cites) && ((x as { cites: unknown[] }).cites).some((c) => typeof c === 'string' && hiddenIds.has(c))))))
        .map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !SALES_HIDDEN_KEYS.has(k)).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(detail);
}

/** A claim as Finance sees it. Approve and reject stay off while a "likely fake" or "check" alert is unmarked. */
export function claimView(c: ClaimRow): ClaimView {
  return { ...c, needsReview: c.alert.level !== 'no_concern' && c.alert.review === null };
}

const LEVEL: Record<string, string> = { likely_fake: 'likely fake', check: 'check', no_concern: 'no concern' };

const CONDITION: Record<string, string> = { payment_days: 'pay within days:', commitment: 'yearly units:', quantity: 'quantity:', order_value: 'order value ₹:' };

const CHANNEL: Record<string, string> = { mail: 'Email channel', chat: 'Chat channel', api: 'API channel', phone: 'Phone call' };
const SALES_EVENTS: Record<string, string> = {
  sales_send: 'Sent',
  sales_change: 'Changed',
  sales_question: 'Asked customer',
  asked_inventory: 'Asked Operations',
  sales_reserve: 'Reserved again',
  reopened: 'Reopened',
  loss_tagged: 'Tagged loss reason',
};

const REFUSAL: Record<string, string> = {
  STALE_STOCK: 'old stock count',
  HOLD_EXPIRED: 'hold expired',
  INSUFFICIENT_STOCK: 'not enough stock',
  NO_CONTRACT_PRICE: 'no contract price',
  UNKNOWN_ACCOUNT: 'unknown account',
  BELOW_MAX_DISCOUNT: 'below max discount',
  ABOVE_CONTRACT: 'above contract price',
  REASON_REQUIRED: 'no reason given',
  CITES_REQUIRED: 'no facts cited',
  CLAIM_CITED: 'cited a buyer claim',
  UNKNOWN_FACT: 'unknown fact cited',
  NEW_CUSTOMER_RULE: 'new-customer rule',
  BAD_PRICE: 'not a valid price',
};

/** 8.3: audit rows as the Audit screen shows them (`actor · event · result`), with the raw row kept. */
function auditRow(r: ReturnType<Store['auditRows']>[number], accountName: string, rfqId: string): AuditRow {
  const d = (r.detail ?? {}) as Record<string, unknown>;
  const seeded = d.seeded === true;
  const agentVersion = r.promptVersion ? `${seeded ? 'seed' : (r.model ?? 'model')} · ${r.promptVersion}` : null;
  let actor = r.actor;
  let event = r.event;
  let result: string | null = null;
  let tone: AuditRow['tone'] = null;
  let version: string | null = null;
  switch (r.event) {
    case 'rfq_received':
      actor = CHANNEL[d.channel as string] ?? 'Channel';
      event = `RFQ received from ${d.account ?? accountName}`;
      result = rfqId;
      break;
    case 'extracted':
      actor = 'Intake agent';
      event = 'Extracted fields';
      result = d.fallback ? 'failed, empty fields' : ((d.partNumber as string | null) ?? 'ambiguous part');
      version = agentVersion;
      break;
    case 'clarification_asked':
      actor = d.template ? 'Template' : 'Clarification agent';
      event = 'Asked buyer';
      result = 'sent';
      version = agentVersion;
      break;
    case 'customer_reply':
      actor = 'Buyer';
      event = 'Reply signal';
      result = typeof d.text === 'string' ? d.text.slice(0, 80) : (((d.structured as Record<string, unknown> | null)?.decision as string) ?? (d.partNumber as string) ?? 'reply');
      break;
    case 'price_check':
      actor = 'Rules';
      event = 'Price and margin check';
      result = d.result === 'pass' ? 'pass' : d.result === 'to_finance' ? 'to Finance' : d.result === 'blocked' ? 'blocked' : `needs ${d.reason}`;
      tone = d.result === 'pass' ? 'ok' : d.result === 'to_finance' ? 'wait' : d.result === 'blocked' ? 'bad' : 'wait';
      version = `policy ${POLICY.version}`;
      break;
    case 'finance_referral':
      actor = d.template ? 'Template' : 'Finance referral agent';
      event = 'Drafted case';
      result = d.fallback ? 'template' : 'drafted';
      version = agentVersion;
      break;
    case 'finance_decision':
      actor = d.role === 'sales' ? 'Sales rep (Finance deadline passed)' : 'Finance';
      event = d.action === 'approve' ? `Approved ${inr(d.unitPrice as number)}` : 'Rejected';
      result = [
        typeof d.reason === 'string' && d.reason ? `“${d.reason}”` : null,
        d.insufficientData ? 'approved with missing data' : Array.isArray(d.factIds) && d.factIds.length ? `cites ${(d.factIds as string[]).join(', ')}` : null,
      ].filter(Boolean).join(' · ') || null;
      tone = d.insufficientData ? 'wait' : d.action === 'approve' ? 'ok' : 'bad';
      break;
    case 'stock_check':
      actor = 'Rules';
      event = 'Stock check';
      result = d.result as string;
      tone = d.result === 'ok' ? 'ok' : 'bad';
      break;
    case 'hold_refused':
      actor = 'Rules';
      event = 'Stock check';
      result = d.reason === 'STALE_STOCK' ? 'old count' : 'short';
      tone = 'bad';
      break;
    case 'hold_placed':
      actor = 'Rules';
      event = 'Stock hold committed, timer set';
      result = `${d.quantity} held to ${fmtTime(d.expiresAt as number)}`;
      tone = 'ok';
      break;
    case 'hold_expired':
      actor = 'Timer';
      event = 'Stock hold expired';
      tone = 'bad';
      break;
    case 'approval_pending':
      actor = 'Sales rep';
      event = 'Approval pending';
      result = 'waiting';
      tone = 'wait';
      break;
    case 'count_confirmed':
      actor = 'Inventory';
      event = 'Count confirmed';
      result = `${d.onHand} on hand`;
      tone = 'ok';
      break;
    case 'quote_sent':
      actor = 'Rules';
      event = 'Rechecked and sent';
      result = `${inr(d.total as number)} to ${d.to as string}`;
      tone = 'ok';
      break;
    case 'reply_read':
      actor = d.byCode ? 'Rules' : 'Decline reader';
      event = 'Read customer reply';
      result = d.fallback ? 'question (fallback)' : `${d.decision}${d.reason ? `, ${d.reason}` : ''}`;
      version = d.byCode ? null : agentVersion;
      break;
    case 'order_booked':
      actor = 'Rules';
      event = 'Order booked';
      result = d.orderRef as string;
      tone = 'ok';
      break;
    case 'reservation_expired':
      actor = 'Timer';
      event = 'Quote expired, stock released';
      tone = 'bad';
      break;
    case 'reservation_released':
      actor = 'Rules';
      event = 'Stock released';
      result = `${d.fromStock} from stock${d.fromPo ? `, ${d.fromPo} from ${d.poId}` : ''}`;
      break;
    case 'injection_flagged':
      actor = 'Rules';
      event = 'Instruction-like text ignored';
      result = d.phrase as string;
      tone = 'wait';
      break;
    case 'ai_budget_reached':
      actor = 'Rules';
      event = 'AI budget reached';
      result = `${d.tokens} tokens`;
      tone = 'bad';
      break;
    case 'needs_sales':
      actor = 'Rules';
      event = 'Sent to Sales';
      result = d.reason === 'AI_BUDGET' ? 'AI budget used up' : 'small order';
      tone = 'wait';
      break;
    case 'stock_feed_read':
      actor = 'Rules';
      event = 'Stock count read';
      result = d.onHand != null ? `${d.onHand} on hand` : null;
      break;
    case 'customer_message':
      actor = 'Buyer';
      event = 'Message received';
      result = 'passed to the quote';
      break;
    case 'discount_conditions': {
      actor = 'Rules';
      event = 'Discount conditions stored';
      const cs = (d.conditions as { kind?: string; required?: number }[] | undefined) ?? [];
      result = cs.map((c) => CONDITION[c.kind ?? ''] ? `${CONDITION[c.kind ?? '']} ${c.required ?? ''}`.trim() : (c.kind ?? '')).join(', ') || null;
      break;
    }
    case 'debit_note_raised':
      actor = 'Rules';
      event = 'Debit note raised';
      result = `${d.noteRef as string} · ${inr(d.amountInr as number)}`;
      tone = 'bad';
      break;
    case 'payment_recorded':
      actor = 'Finance';
      event = 'Payment recorded';
      result = `paid in ${d.paidDays} days`;
      break;
    case 'order_part_cancelled':
      actor = 'Buyer';
      event = 'Part of the order cancelled';
      result = `${d.cancelled} cancelled, ${d.quantity} left`;
      tone = 'wait';
      break;
    case 'outbound_blocked':
      actor = 'Rules';
      event = 'Message to customer stopped by the check';
      result = String(d.action ?? 'blocked');
      tone = 'bad';
      break;
    case 'accept_not_booked':
      actor = 'Rules';
      event = 'Acceptance not booked';
      result = d.reason === 'HOLD_LIMIT' ? 'buyer at its hold limit' : 'buyer not in good standing';
      tone = 'bad';
      break;
    case 'sales_question_blocked':
      actor = 'Rules';
      event = 'Sales question stopped by the check';
      result = 'internal information';
      tone = 'bad';
      break;
    case 'loss_recorded':
      actor = r.actor === 'decline-reader' ? 'Decline reader' : 'Buyer';
      event = 'Loss reason recorded';
      result = (d.reason as string | null) ?? 'not given';
      break;
    case 'send_refused':
      actor = 'Rules';
      event = 'Send refused';
      result = REFUSAL[d.reason as string] ?? String(d.reason ?? 'refused');
      tone = 'bad';
      break;
    case 'terms_changed':
      actor = 'Rules';
      event = 'Price changed since the draft';
      result = d.current != null ? `now ${inr(d.current as number)}` : 'new draft';
      tone = 'wait';
      break;
    case 'sales_send_ignored':
      actor = 'Rules';
      event = 'Send on an old draft ignored';
      result = 'draft changed';
      tone = 'wait';
      break;
    case 'finance_signal_ignored':
      actor = 'Rules';
      event = 'Finance price refused';
      result = REFUSAL[d.code as string] ?? String(d.code ?? 'refused');
      tone = 'bad';
      break;
    case 'input_truncated':
      actor = 'Rules';
      event = 'Long message shortened';
      result = d.keptChars != null && d.originalChars != null ? `${d.keptChars} of ${d.originalChars} characters` : null;
      tone = 'wait';
      break;
    case 'claim_recorded':
      actor = 'Rules';
      event = 'Buyer claim logged';
      result = `${d.claimedPrice != null ? `${inr(d.claimedPrice as number)}, ` : ''}unverified`;
      tone = 'wait';
      break;
    case 'alert_raised':
      actor = 'Rules';
      event = 'Fake-rival alert';
      result = LEVEL[d.level as string] ?? String(d.level);
      tone = d.level === 'likely_fake' ? 'bad' : d.level === 'check' ? 'wait' : 'ok';
      version = (d.thresholdVersion as string) ?? null;
      break;
    case 'alert_reviewed':
      actor = 'Finance';
      event = 'Alert marked';
      result = d.verdict === 'correct' ? 'Correct' : 'Wrong';
      tone = 'ok';
      break;
    case 'claim_verified':
      actor = 'Finance';
      event = 'Claim verified';
      result = d.result === 'fake' ? 'Fake' : 'Genuine';
      tone = d.result === 'fake' ? 'bad' : 'ok';
      break;
    case 'evidence_read':
      actor = 'Claim evidence reader';
      event = 'Read rival document';
      result = `${(d.findings as unknown[] | undefined)?.length ?? 0} cited findings`;
      version = agentVersion;
      break;
    case 'prompt_leak_attempt':
      actor = 'Rules';
      event = 'prompt-leak attempt';
      result = 'template sent';
      tone = 'bad';
      break;
    case 'prompt_probe':
      actor = 'Rules';
      event = 'prompt-leak attempt';
      result = 'request for instructions treated as data';
      tone = 'bad';
      break;
    case 'probe_counted':
      actor = 'Rules';
      event = 'Probe counted';
      result = String(d.kind ?? '');
      tone = 'wait';
      break;
    case 'discounts_frozen':
      actor = 'Rules';
      event = 'Discounts frozen for buyer group';
      result = String(d.reason ?? '');
      tone = 'bad';
      break;
    case 'finance_deadline_passed':
      actor = 'Timer';
      event = 'Finance deadline passed';
      result = d.fallback === 'standing_price' ? 'standing price holds' : 'rep decides';
      tone = 'wait';
      break;
    case 'cached_price':
      actor = 'Rules';
      event = 'Same request, same price';
      result = `${inr(d.unitPrice as number)} from ${d.quoteRef as string}`;
      break;
    case 'commitment_recorded':
      actor = 'Sales rep';
      event = 'Year volume committed';
      result = `${d.annualQty} × ${d.itemCode}`;
      break;
    case 'accept_refused':
      actor = 'Rules';
      event = 'Acceptance refused';
      result = d.reason === 'QUOTE_EXPIRED' ? 'quote expired' : String(d.reason ?? 'refused');
      tone = 'bad';
      break;
    default:
      if (SALES_EVENTS[r.event]) {
        actor = 'Sales rep';
        event = SALES_EVENTS[r.event]!;
        result = (d.reason as string) ?? (d.delivery as string) ?? null;
      } else if (r.event.startsWith('message_')) {
        actor = 'Code';
        event = `Message to customer: ${r.event.slice(8).replace(/_/g, ' ')}`;
        result = 'sent';
      } else {
        // An event with no wording of its own still reads as words, not a column name.
        actor = r.actor.charAt(0).toUpperCase() + r.actor.slice(1).replace(/-/g, ' ');
        event = r.event.charAt(0).toUpperCase() + r.event.slice(1).replace(/_/g, ' ');
      }
  }
  return { id: r.id, at: r.at, actor, event, version, result, tone, raw: { event: r.event, actor: r.actor, model: r.model, promptVersion: r.promptVersion, detail: r.detail } };
}
