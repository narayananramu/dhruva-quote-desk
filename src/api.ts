import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError, type Client } from '@temporalio/client';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { describe as describeClarify } from './agents/clarification';
import { describe as describeDecline } from './agents/decline-reader';
import { describe as describeEvidence } from './agents/evidence';
import { checkReasonCites } from './agents/grounding';
import { describe as describeFinance } from './agents/finance-referral';
import { describe as describeIntake } from './agents/intake';
import { LOSS_REASONS } from './agents/prompts';
import { BUDGET, DEMO_START } from './config';
import type { Account, Role, SalesAction, Session, Settings, Stage, UsageReport } from './contract';
import { checkFinancePrice, floorPriceOf, fmtTime, isSmallOrder, minPriceOf, ruleInputsOf, validQuantity } from './domain';
import { outboundProblem } from './agents/guardrails';
import { queueQuery } from './queue';
import { seedDemo, TEST_REQUESTS } from './seed';
import type { QuoteInput, QuoteState } from './state';
import type { RfqRow, Store } from './store';
import { costConfig, paise, pricePerM, type CostConfig } from './usage';
import { claimView, stateOf, Views } from './views';
import { clockSignal, customerReplySignal, financeDecisionSignal, quoteWorkflow, salesActionSignal, stockConfirmedSignal, type CounterOffer, type CustomerReply, type FinanceSignal } from './workflows';
import type { ModelIds } from './models';

export interface ApiDeps {
  client: Client;
  store: Store;
  taskQueue: string;
  queueId?: string;
  /** Demo clock. Default: real time + the offset in settings. Tests pass the time-skipping clock. */
  clock?: () => number;
  costs?: CostConfig;
  modelIds?: ModelIds | null;
  /** How long writes wait for the workflow to publish (8.1: 5 s). */
  settleMs?: number;
  /** Deployment stage. 'prod' refuses the demo login (A5): production uses SSO and signed customer API keys. */
  stage?: string;
}

type User = { kind: 'staff'; role: 'sales' | 'finance' | 'inventory'; name: string } | { kind: 'customer'; account: string; name: string } | { kind: 'professor'; name: 'professor' };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * HTTP API (DESIGN.md section 8). Reads come from the SQLite projection; writes start a workflow or
 * send a signal, then wait for the next snapshot. Demo login: header `x-demo-user` (not real auth).
 */
export function createApi(deps: ApiDeps): Api {
  const { client, store, taskQueue } = deps;
  const costs = deps.costs ?? costConfig();
  const views = new Views(store, costs, deps.modelIds?.intake ?? null);
  const now = deps.clock ?? (() => Date.now() + store.clockOffset());
  const offset = () => (deps.clock ? 0 : store.clockOffset());
  const settleMs = deps.settleMs ?? 5000;
  const stage = deps.stage ?? process.env.STAGE ?? 'demo';
  if (stage !== 'test') console.warn(stage === 'prod' ? 'STAGE=prod: demo login refused; every request except /health returns 503.' : 'Demo login: the x-demo-user header is not authentication. Do not expose this API publicly.');
  const origins = (process.env.WEB_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((s) => s.trim());

  // ---- Helpers ----

  function parseUser(h: string | string[] | undefined): User | undefined {
    const v = (Array.isArray(h) ? h[0] : h)?.trim();
    if (v === 'sales' || v === 'finance' || v === 'inventory') return { kind: 'staff', role: v, name: v };
    if (v === 'professor') return { kind: 'professor', name: 'professor' };
    const m = v?.match(/^customer:([A-Z0-9-]+)$/);
    return m && store.account(m[1]!) ? { kind: 'customer', account: m[1]!, name: v! } : undefined;
  }
  const isStaff = (u: User) => u.kind !== 'customer';
  const forSales = (u: User) => u.kind === 'staff' && u.role === 'sales';
  function need(u: User, ...roles: ('sales' | 'finance' | 'inventory' | 'customer' | 'staff')[]) {
    if (u.kind === 'professor') return;
    if (u.kind === 'customer' && roles.includes('customer')) return;
    if (u.kind === 'staff' && (roles.includes(u.role) || roles.includes('staff'))) return;
    throw new HttpError(403, 'not allowed for this role');
  }
  function ownAccount(u: User, account: string) {
    if (!store.account(account)) throw new HttpError(404, 'not found');
    if (u.kind === 'professor') return;
    if (u.kind === 'customer' && u.account === account) return;
    if (u.kind === 'customer') throw new HttpError(404, 'not found');
    throw new HttpError(403, 'customers only');
  }
  const accountOf = (code: string): Account => {
    const a = store.account(code)!;
    return { code: a.code, name: a.name, email: a.email };
  };
  function rfqOr404(id: string): RfqRow {
    const r = store.rfq(id);
    if (!r) throw new HttpError(404, 'not found');
    return r;
  }

  async function waitSettled(rfqId: string, prevSeq: number, ms = settleMs): Promise<boolean> {
    const end = Date.now() + ms;
    for (;;) {
      const r = store.rfq(rfqId);
      if (r && r.seq > prevSeq && views.stage(stateOf(r), now()) !== 'reading') return true;
      if (Date.now() >= end) return false;
      await new Promise((res) => setTimeout(res, 50));
    }
  }

  async function signal(r: RfqRow, def: Parameters<ReturnType<Client['workflow']['getHandle']>['signal']>[0], arg: unknown) {
    try {
      await client.workflow.getHandle(r.workflowId).signal(def as never, arg as never);
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) throw new HttpError(409, 'the quote workflow is not running');
      throw e;
    }
  }

  async function startRfq(a: Omit<QuoteInput, 'rfqId' | 'quoteRef' | 'clockOffsetMs' | 'workflowId' | 'receivedAt'> & { rfqId?: string; quoteRef?: string; receivedAt?: number; clientKey?: string | null; replace?: boolean }) {
    const ids = a.rfqId && a.quoteRef ? { rfqId: a.rfqId, quoteRef: a.quoteRef } : store.allocateRfq();
    const workflowId = store.workflowIdFor(ids.rfqId);
    const receivedAt = a.receivedAt ?? now();
    const { clientKey, replace, ...rest } = a;
    if (!store.rfq(ids.rfqId)) store.insertRfq({ ...ids, workflowId, account: a.account, channel: a.channel, receivedAt, clientKey: clientKey ?? null });
    if (a.messageId) store.setMessageRfq(a.messageId, ids.rfqId);
    const input: QuoteInput = { ...rest, ...ids, workflowId, receivedAt, clockOffsetMs: offset() };
    await client.workflow.start(quoteWorkflow, { taskQueue, workflowId, args: [input], workflowIdConflictPolicy: replace ? 'TERMINATE_EXISTING' : 'FAIL' });
    return { ...ids, workflowId };
  }

  const settings = (): Settings => ({ now: now(), staleStock: store.staleStock(), testRequests: TEST_REQUESTS.map((t) => ({ id: t.id, label: t.label })) });

  function session(u: User): Session {
    const all = store.accounts();
    const roles: Role[] = u.kind === 'professor' ? ['sales', 'finance', 'inventory', 'customer'] : u.kind === 'customer' ? ['customer'] : [u.role];
    return { user: u.name, roles, accounts: u.kind === 'customer' ? all.filter((a) => a.code === u.account) : all, salesRep: 'Priya N.', now: now() };
  }

  async function reset(): Promise<Settings> {
    for (const r of store.rfqs()) {
      if (r.state?.final) continue;
      await client.workflow
        .getHandle(r.workflowId)
        .terminate('demo reset')
        .catch(() => undefined);
    }
    const epoch = store.isEmpty() ? 1 : store.epoch() + 1;
    const t0 = deps.clock ? deps.clock() : DEMO_START;
    store.resetAll(t0, epoch);
    store.setSetting('clock_offset_ms', deps.clock ? 0 : DEMO_START - Date.now());
    const inputs = seedDemo(store, now());
    const started = [];
    for (const i of inputs) started.push(await startRfq({ ...i, replace: true }));
    await Promise.all(started.map((s) => waitSettled(s.rfqId, 0, 15_000)));
    return settings();
  }

  /**
   * True when the stored quotes have no running workflow behind them: Temporal was restarted with an
   * in-memory history while the SQLite file kept the old quotes. Every action would fail with 409.
   */
  async function orphaned(): Promise<boolean> {
    for (const r of store.rfqs()) {
      if (r.state?.final) continue;
      try {
        const d = await client.workflow.getHandle(r.workflowId).describe();
        if (d.status.name !== 'RUNNING') return true;
      } catch (e) {
        if (e instanceof WorkflowNotFoundError) return true;
        throw e;
      }
    }
    return false;
  }

  /** `POST /v1/rfq` and `GET /v1/rfq/:id` buyer view: no internals. */
  function buyerStatus(r: RfqRow) {
    const s = stateOf(r);
    const stage = views.stage(s, now());
    const base = { rfq_id: s.rfqId, quote_ref: s.quoteRef };
    // DECISIONS 11: a request that names a price gets one status whatever its band (ready, with Finance,
    // blocked), and no price is shown before a quote is sent, so neither reveals a limit.
    const asked = s.request?.requestedUnitPrice != null;
    const waiting: Stage[] = ['ready', 'short', 'stale', 'hold_expired', 'with_inventory', 'needs_sales', 'with_finance', 'blocked', 'finance_rejected'];
    if ((asked && waiting.includes(stage)) || stage === 'with_finance' || stage === 'blocked' || stage === 'finance_rejected') return { status: 'pending_approval', ...base, reply_by: 'today' };
    if (stage === 'ready') return { status: 'pending_review', ...base, part: s.item!.itemCode, quantity: s.quantity, ...(s.hold && { stock_reserved_until: fmtTime(s.hold.expiresAt) }) };
    if (stage === 'short' && s.deliveryOffer) {
      const o = s.deliveryOffer;
      return {
        status: 'pending_review',
        ...base,
        available_now: o.availableNow,
        ...(o.po && { arriving: { quantity: o.po.quantity, date: o.po.arrivesOn, po: o.po.id } }),
        earliest_full_delivery: o.readyOn,
        options: s.deliveryOptions.map((d) => `${d.id}: ${d.parts.map((p) => `${p.quantity} on ${p.on}`).join(', ')}`),
      };
    }
    if (stage === 'needs_customer') return { status: 'needs_clarification', rfq_id: s.rfqId, question: s.question?.text ?? '' };
    if (stage === 'sent') return { status: 'quoted', ...base, unit_price_inr: s.sent!.unitPrice, total_inr: s.sent!.total, valid_until: s.sent!.validUntil };
    if (stage === 'ordered') return { status: 'ordered', ...base, order_ref: s.order!.ref };
    if (stage === 'lost' || stage === 'quote_expired' || stage === 'closed') return { status: stage === 'quote_expired' ? 'expired' : stage, ...base };
    return { status: 'received', rfq_id: s.rfqId };
  }

  function lastOutbound(r: RfqRow): string | null {
    const out = store.messagesForRfq(r.rfqId).filter((m) => m.direction === 'out');
    return out.at(-1)?.chat ?? out.at(-1)?.text ?? null;
  }

  // ---- Sales action checks (8.3) ----

  function checkSalesAction(body: unknown, s: QuoteState, stage: Stage, allowed: string[]): SalesAction {
    const a = body as Record<string, unknown>;
    const frozen = store.frozen(s.account, now());
    const t = a?.type;
    if (typeof t !== 'string' || !['send', 'change', 'question', 'ask_inventory', 'reserve', 'reopen', 'tag_loss'].includes(t)) throw new HttpError(400, 'unknown action type');
    if (!allowed.includes(t)) throw new HttpError(409, `${t} is not available while the quote is ${stage}`);
    /**
     * Price limits for a Sales-typed price, from the item and quantity the price will apply to (a
     * `change` may set a new item or quantity). Null when the item has no contract price yet.
     */
    const limitsFor = (itemCode: string | null | undefined, quantity: number | null | undefined) => {
      if (!itemCode) return null;
      const same = s.price && s.price.itemCode === itemCode;
      const item = same ? null : store.item(itemCode);
      const contract = same ? s.price!.contractPrice : store.contractPrice(s.account, itemCode);
      if (contract === null || (!same && !item)) return null;
      const floorPrice = same ? s.price!.floorPrice : floorPriceOf(contract, item!.maxDiscountPct);
      const minPrice = same ? s.price!.minPrice : minPriceOf(item!.unitCost, item!.minMarginPct);
      const qty = quantity ?? s.price?.quantity ?? s.quantity ?? null;
      return { floorPrice, minPrice, contract, small: qty !== null && isSmallOrder(qty, contract) };
    };
    const priceOk = (p: unknown, lim: ReturnType<typeof limitsFor>) => {
      if (typeof p !== 'number' || !Number.isInteger(p) || p <= 0) throw new HttpError(422, 'Price must be a whole number of rupees', 'BAD_PRICE');
      if (!lim) return;
      // The contract price is the most a customer pays (as on Finance): a rep's price above it is a typo or an overcharge.
      if (lim.contract !== null && p > Math.max(lim.contract, lim.small ? lim.minPrice : 0)) throw new HttpError(422, 'Above the contract price', 'ABOVE_CONTRACT');
      // The max-discount price is Finance-only: the rep is told the price is too low, not where the floor is.
      if (p < lim.floorPrice) throw new HttpError(422, 'Below the lowest price Finance can approve', 'BELOW_MAX_DISCOUNT');
      if (frozen && lim.contract !== null && p < lim.contract) throw new HttpError(422, "Discounts are frozen for this buyer group: contract price only", 'FROZEN');
      // 13: a small order never goes to Finance, so the lowest price Sales can send is the minimum.
      if (lim.small && p < lim.minPrice) throw new HttpError(422, `Small order: lowest price is ₹${lim.minPrice}`, 'SMALL_ORDER_MIN');
      // L1: below the sent price a revision needs Finance, and small orders have no Finance step.
      if (lim.small && s.priceLocked !== null && p < s.priceLocked) throw new HttpError(422, 'Small order: the sent price stands', 'PRICE_LOCKED');
    };
    switch (t) {
      case 'send':
        if (typeof a.draftVersion !== 'number') throw new HttpError(400, 'draftVersion required');
        if (stage === 'short' && !s.deliveryOptions.some((o) => o.id === a.delivery)) throw new HttpError(422, 'Unknown delivery option', 'UNKNOWN_DELIVERY');
        return { type: 'send', draftVersion: a.draftVersion, ...(typeof a.delivery === 'string' && { delivery: a.delivery as 'split' | 'full' }) };
      case 'change': {
        if (typeof a.reason !== 'string' || a.reason.trim().length < 3) throw new HttpError(422, 'Give a reason of at least 3 characters', 'REASON_REQUIRED');
        if (a.quantity !== undefined && !validQuantity(a.quantity)) throw new HttpError(422, 'Quantity must be 1 to 100,000', 'BAD_QUANTITY');
        if (a.itemCode !== undefined && (typeof a.itemCode !== 'string' || !store.exactPart(a.itemCode))) throw new HttpError(422, 'Unknown item', 'UNKNOWN_ITEM');
        if (a.deliverBy !== undefined && (typeof a.deliverBy !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.deliverBy))) throw new HttpError(422, 'Date must be YYYY-MM-DD', 'BAD_DATE');
        if (a.unitPrice !== undefined) {
          const code = a.itemCode !== undefined ? store.exactPart(a.itemCode as string) : (s.price?.itemCode ?? s.item?.itemCode);
          priceOk(a.unitPrice, limitsFor(code, a.quantity as number | undefined));
        }
        if (a.commitAnnualQty !== undefined) {
          // A year's volume is at least this order's quantity; anything less is not a commitment.
          const orderQty = (a.quantity as number | undefined) ?? s.quantity ?? 1;
          if (!(typeof a.commitAnnualQty === 'number' && Number.isInteger(a.commitAnnualQty) && a.commitAnnualQty <= 10_000_000))
            throw new HttpError(422, 'Committed yearly quantity must be a whole number', 'BAD_COMMITMENT');
          if (a.commitAnnualQty < orderQty) throw new HttpError(422, `A year's volume is at least this order's ${orderQty} units`, 'BAD_COMMITMENT');
        }
        return {
          ...(a.commitAnnualQty !== undefined && { commitAnnualQty: a.commitAnnualQty as number }),
          type: 'change',
          reason: (a.reason as string).trim(),
          ...(a.quantity !== undefined && { quantity: a.quantity as number }),
          ...(a.unitPrice !== undefined && { unitPrice: a.unitPrice as number }),
          ...(a.deliverBy !== undefined && { deliverBy: a.deliverBy as string }),
          ...(a.itemCode !== undefined && { itemCode: store.exactPart(a.itemCode as string)! }),
        };
      }
      case 'question': {
        if (typeof a.text !== 'string' || !a.text.trim() || a.text.length > 1000) throw new HttpError(422, 'Question must be 1 to 1,000 characters', 'BAD_TEXT');
        // DECISIONS 11 and threat 8: a rep's question goes to the customer word for word, so it is
        // scanned like every other outbound text. Only the sent price may appear as a rupee figure.
        const text = a.text.trim();
        const bad = outboundProblem(text, { money: s.sent ? [s.sent.unitPrice, s.sent.total] : [], otherAccountNames: store.otherAccountNames(s.account) });
        if (bad) {
          store.audit(now(), s.rfqId, 'sales_question_blocked', { problem: bad }, { actor: 'rules' });
          throw new HttpError(422, 'A question to the customer cannot mention cost, margin, discounts, win rates, limits or any price other than the sent one', 'INTERNAL_INFO');
        }
        return { type: 'question', text };
      }
      case 'reopen':
        priceOk(a.unitPrice, limitsFor(s.price?.itemCode ?? s.item?.itemCode, null));
        if (!s.deliveryOptions.some((o) => o.id === a.delivery)) throw new HttpError(422, 'Unknown delivery option', 'UNKNOWN_DELIVERY');
        if (a.reason !== undefined && (typeof a.reason !== 'string' || a.reason.trim().length > 300)) throw new HttpError(422, 'Reason must be up to 300 characters', 'BAD_REASON');
        return { type: 'reopen', unitPrice: a.unitPrice as number, delivery: a.delivery as 'stock' | 'split' | 'full', ...(typeof a.reason === 'string' && a.reason.trim() && { reason: a.reason.trim() }) };
      case 'tag_loss':
        if (!(LOSS_REASONS as readonly string[]).includes(a.reason as string)) throw new HttpError(422, 'Unknown loss reason', 'BAD_REASON');
        return { type: 'tag_loss', reason: a.reason as (typeof LOSS_REASONS)[number] };
      default:
        return { type: t as 'ask_inventory' | 'reserve' };
    }
  }

  function usageReport(): UsageReport {
    const rows = store.rfqs().map((r) => {
      const s = stateOf(r);
      return { rfqId: s.rfqId, quoteRef: s.quoteRef, accountName: accountOf(s.account).name, stage: views.stage(s, now()), usage: views.usage(s) };
    });
    const sum = (f: (u: (typeof rows)[number]['usage']) => number) => paise(rows.reduce((n, r) => n + f(r.usage), 0));
    const gross = rows.reduce((n, r) => n + (r.usage.grossMarginInr ?? 0), 0);
    const total = sum((u) => u.totalInr);
    const models = [...new Set(Object.values(deps.modelIds ?? {}))];
    return {
      now: now(),
      stage: costs.stage,
      prices: [...new Set([...models, ...Object.keys(costs.prices)])].map((m) => ({ model: m, inrPerMTokens: pricePerM(costs, m) })),
      computeInrPerRfq: costs.computeInrPerRfq,
      actionsPerRfq: costs.actionsPerRfq,
      capTokens: BUDGET.tokenCapPerRfq,
      smallOrderBelowInr: BUDGET.smallOrderBelowInr,
      totals: {
        quotes: rows.length,
        tokens: rows.reduce((n, r) => n + r.usage.tokens.total, 0),
        aiInr: sum((u) => u.aiInr),
        computeInr: sum((u) => u.computeInr),
        totalInr: total,
        grossMarginInr: gross,
        pctOfMargin: gross > 0 ? Math.round((total / gross) * 1_000_000) / 10_000 : null, // four decimals, as on each quote
      },
      quotes: rows,
    };
  }

  // ---- Access code (hosted demo) ----
  const codeRequired = () => process.env.DEMO_REQUIRE_CODE === '1';
  const misses = new Map<string, { n: number; since: number }>();
  const clientIp = (req: IncomingMessage) =>
    (String(req.headers['x-forwarded-for'] ?? '').split(',')[0] ?? '').trim() || req.socket.remoteAddress || 'unknown';
  const codeLocked = (ip: string) => {
    const e = misses.get(ip);
    if (!e) return false;
    if (Date.now() - e.since > 15 * 60_000) { misses.delete(ip); return false; }
    return e.n >= 10;
  };
  const codeFailed = (ip: string) => {
    const e = misses.get(ip);
    if (!e || Date.now() - e.since > 15 * 60_000) misses.set(ip, { n: 1, since: Date.now() });
    else e.n += 1;
  };

  // ---- Router ----

  async function route(req: IncomingMessage, res: ServerResponse, path: string[]): Promise<void> {
    const m = req.method ?? 'GET';
    const [a, b, c, d] = path;
    if (m === 'GET' && a === 'health') return send(res, 200, { ok: true, codeRequired: codeRequired() });
    // A5: x-demo-user is spoofable by design; it must never be the login in production.
    if (stage === 'prod') throw new HttpError(503, 'demo login is disabled when STAGE=prod; configure SSO and customer API keys', 'DEMO_AUTH_DISABLED');

    if (a === 'session' && !b && m === 'POST') {
      const body = await json(req);
      const code = process.env.DEMO_ACCESS_CODE ?? 'DHRUVA-DEMO';
      const ip = clientIp(req);
      if (codeLocked(ip)) throw new HttpError(429, 'too many wrong codes; try again in 15 minutes', 'CODE_LOCKED');
      const given = body.code === undefined ? undefined : String(body.code).trim();
      if ((codeRequired() && given === undefined) || (given !== undefined && given !== code)) {
        codeFailed(ip);
        throw new HttpError(401, 'wrong access code', 'WRONG_CODE');
      }
      return send(res, 200, session({ kind: 'professor', name: 'professor' }));
    }
    // DEMO_REQUIRE_CODE=1: every request must carry the access code (the hosted demo uses a real, paid model).
    if (codeRequired() && String(req.headers['x-demo-code'] ?? '') !== (process.env.DEMO_ACCESS_CODE ?? 'DHRUVA-DEMO')) {
      throw new HttpError(401, 'access code required', 'CODE_REQUIRED');
    }

    const user = parseUser(req.headers['x-demo-user']);
    if (!user) throw new HttpError(401, 'set x-demo-user: sales | finance | inventory | customer:<ACCOUNT> | professor');

    if (a === 'session' && !b && m === 'GET') return send(res, 200, session(user));

    // -- Sales --
    if (a === 'quotes' && !b && m === 'GET') {
      need(user, 'sales', 'finance');
      return send(res, 200, { now: now(), quotes: store.rfqs().map((r) => views.summary(r, now())) });
    }
    if (a === 'quotes' && b && !c && m === 'GET') {
      need(user, 'sales', 'finance');
      return send(res, 200, { now: now(), quote: views.detail(rfqOr404(b), now(), forSales(user)) });
    }
    if (a === 'quotes' && b && c === 'win-rate' && m === 'GET') {
      // Live on the reopen form: win rate and expected gross profit at a typed price. Staff only.
      need(user, 'sales', 'finance');
      const s = stateOf(rfqOr404(b));
      const price = Number(new URL(req.url ?? '/', 'http://local').searchParams.get('price'));
      if (!s.price || !Number.isInteger(price) || price <= 0) throw new HttpError(422, 'price must be a whole number of rupees and the quote must have a price', 'BAD_PRICE');
      return send(res, 200, { now: now(), winRate: views.winRateView(s.price, price, now()) });
    }
    if (a === 'quotes' && b && c === 'actions' && m === 'POST') {
      need(user, 'sales');
      const r = rfqOr404(b);
      const body = await json(req);
      const detail = views.detail(r, now());
      const st = stateOf(r);
      const action = checkSalesAction(body, st, detail.stage, detail.actions);
      // The commitment is recorded by the workflow once it takes the change, never before.
      if (action.type === 'change' && action.commitAnnualQty && !(action.itemCode ?? st.item?.itemCode)) throw new HttpError(422, 'No item to commit to', 'UNKNOWN_ITEM');
      await signal(r, salesActionSignal, { ...action, by: user.name });
      const ok = await waitSettled(r.rfqId, r.seq);
      const after = views.detail(rfqOr404(b), now(), forSales(user));
      // L1: a price below the sent price is not refused; it goes to Finance and the response says so.
      const price = action.type === 'reopen' || action.type === 'change' ? action.unitPrice : undefined;
      const needsFinance = price !== undefined && st.priceLocked !== null && price < st.priceLocked;
      return send(res, 200, { now: now(), quote: after, settled: ok, ...(needsFinance && { needsFinance: true, code: 'NEEDS_FINANCE' }) });
    }
    if (a === 'phone-calls' && !b && m === 'POST') {
      need(user, 'sales');
      const body = await json(req);
      if (typeof body.account !== 'string' || !store.account(body.account)) throw new HttpError(422, 'Unknown customer', 'UNKNOWN_ACCOUNT');
      if (typeof body.text !== 'string' || !body.text.trim()) throw new HttpError(422, 'Say what they asked for', 'BAD_TEXT');
      const caller = typeof body.caller === 'string' ? body.caller.slice(0, 80) : '';
      // A double click sends the same key twice: the second request returns the first RFQ.
      const key = typeof body.key === 'string' && body.key ? `phone:${body.key.slice(0, 80)}` : null;
      const existing = key ? store.rfqByClientKey(body.account, key) : undefined;
      if (existing) return send(res, 200, { rfqId: existing.rfqId, quoteRef: existing.quoteRef });
      const s = await startRfq({ account: body.account, channel: 'phone', text: body.text, caller, createdBy: store.account(body.account)!.owner, clientKey: key });
      return send(res, 201, { rfqId: s.rfqId, quoteRef: s.quoteRef });
    }

    // -- Finance --
    if (a === 'finance' && b === 'queue' && m === 'GET') {
      need(user, 'finance');
      return send(res, 200, { now: now(), cases: views.financeQueue(now()) });
    }
    if (a === 'finance' && b && c === 'decision' && m === 'POST') {
      // Finance decides; after the 4-business-hour deadline the rep may decide on the same figures,
      // except on a claim quote or a frozen group (ADVERSARIAL 16).
      need(user, 'finance', 'sales');
      const r = rfqOr404(b);
      const s = stateOf(r);
      const body = await json(req);
      if (s.status !== 'awaiting_finance' || !s.price || !s.finance) throw new HttpError(409, 'this case is not waiting for Finance');
      const role: 'finance' | 'sales' = user.kind === 'staff' && user.role === 'sales' ? 'sales' : 'finance';
      // Item 16 is read now: a claim on the quote, or the group frozen since the case opened, keeps it with Finance.
      const standingOnly = s.finance.standingPriceOnly || s.claim !== null || store.frozen(s.account, now());
      if (role === 'sales' && (!s.finance.repMayDecide || standingOnly))
        throw new HttpError(403, standingOnly ? 'Claim quote or frozen group: only Finance decides' : 'Finance decides until the deadline', 'FINANCE_ONLY');
      const open = store.claims({ rfqId: r.rfqId }).map(claimView).filter((x) => x.needsReview);
      if (open.length) throw new HttpError(409, 'Mark the alert Correct or Wrong first', 'ALERT_UNREVIEWED');
      let sig: FinanceSignal;
      if (body.action === 'approve') {
        const ref = s.finance.referral;
        // The rep decides on the same figures: the price on the case, nothing else (A4: no price search for the floor).
        if (role === 'sales' && body.unitPrice !== s.finance.requestedUnitPrice)
          throw new HttpError(422, 'After the deadline the rep approves or rejects the price on the case', 'CASE_PRICE_ONLY');
        const bad = checkFinancePrice(body.unitPrice, body.reason, s.price, ref ? ruleInputsOf(ref.facts) : null);
        if (bad) throw new HttpError(422, bad.error, bad.code);
        if ((body.unitPrice as number) < s.price.contractPrice) {
          const c = checkReasonCites(body.factIds, ref?.factList ?? []);
          if (c) throw new HttpError(422, c.error, c.code);
        }
        if (ref?.dataStatus === 'insufficient' && (typeof body.reason !== 'string' || body.reason.trim().length < 3))
          throw new HttpError(422, 'The case is missing data: give a written reason', 'REASON_REQUIRED');
        sig = {
          action: 'approve',
          unitPrice: body.unitPrice as number,
          ...(typeof body.reason === 'string' && body.reason.trim() && { reason: body.reason.trim() }),
          ...(Array.isArray(body.factIds) && { factIds: body.factIds as string[] }),
          by: user.name,
          role,
        };
      } else if (body.action === 'reject') sig = { action: 'reject', ...(typeof body.reason === 'string' && body.reason.trim() && { reason: body.reason.trim().slice(0, 300) }), by: user.name, role };
      else throw new HttpError(400, 'action must be approve or reject');
      await signal(r, financeDecisionSignal, sig);
      // Wait until the recheck has run (sent, or back with Sales).
      const end = Date.now() + settleMs;
      let ok = false;
      while (Date.now() < end) {
        const cur = stateOf(rfqOr404(b));
        if (cur.finance?.status !== 'waiting' && (cur.finance?.outcome !== 'checking' || cur.status === 'finance_rejected') && views.stage(cur, now()) !== 'reading') {
          ok = true;
          break;
        }
        await new Promise((x) => setTimeout(x, 50));
      }
      // A4: the rep's answer is the quote as Sales sees it, never the Finance case (which holds the max discount).
      if (role === 'sales') return send(res, 200, { now: now(), quote: views.detail(rfqOr404(b), now(), true), settled: ok });
      return send(res, 200, { now: now(), case: views.financeCase(rfqOr404(b), now()), settled: ok });
    }
    if (a === 'customers' && b && c === 'history' && m === 'GET') {
      need(user, 'finance');
      if (!store.account(b)) throw new HttpError(404, 'not found');
      return send(res, 200, { now: now(), history: store.history(b, now()) });
    }

    // -- Claims and fake-rival alerts (F1) --
    if (a === 'claims' && !b && m === 'GET') {
      need(user, 'finance');
      const rfqId = new URL(req.url ?? '/', 'http://local').searchParams.get('rfqId') ?? undefined;
      return send(res, 200, { now: now(), claims: store.claims(rfqId ? { rfqId } : {}).map(claimView) });
    }
    if (a === 'alerts' && b === 'metrics' && m === 'GET') {
      need(user, 'finance');
      return send(res, 200, { now: now(), metrics: store.alertMetrics() });
    }
    if (a === 'alerts' && b && c === 'review' && m === 'POST') {
      need(user, 'finance');
      const body = await json(req);
      if (body.verdict !== 'correct' && body.verdict !== 'wrong') throw new HttpError(422, 'verdict must be correct or wrong', 'BAD_VERDICT');
      const row = store.reviewAlert(b, body.verdict, user.name, now());
      if (!row) throw new HttpError(404, 'not found');
      return send(res, 200, { now: now(), claim: claimView(row) });
    }
    if (a === 'claims' && b && c === 'verify' && m === 'POST') {
      // Recorded by Finance after Sales Operations checked through an independent channel.
      need(user, 'finance');
      const body = await json(req);
      if (body.result !== 'genuine' && body.result !== 'fake') throw new HttpError(422, 'result must be genuine or fake', 'BAD_RESULT');
      if (typeof body.channel !== 'string' || body.channel.trim().length < 3) throw new HttpError(422, 'Say how it was verified (for example: called the officer on the CRM number)', 'CHANNEL_REQUIRED');
      const before = store.claims({ claimId: b })[0];
      if (!before) throw new HttpError(404, 'not found');
      if (before.verification) throw new HttpError(409, 'already verified', 'ALREADY_VERIFIED');
      const row = store.verifyClaim(b, body.result, body.channel.trim().slice(0, 200), user.name, now());
      return send(res, 200, { now: now(), claim: claimView(row!) });
    }
    if (a === 'customers' && b && c === 'commitments' && !d) {
      need(user, 'sales', 'finance');
      if (!store.account(b)) throw new HttpError(404, 'not found');
      if (m === 'POST') {
        need(user, 'sales');
        const body = await json(req);
        if (typeof body.itemCode !== 'string' || !store.exactPart(body.itemCode)) throw new HttpError(422, 'Unknown item', 'UNKNOWN_ITEM');
        if (typeof body.annualQty !== 'number' || !Number.isInteger(body.annualQty) || body.annualQty < 1) throw new HttpError(422, 'annualQty must be a whole number', 'BAD_COMMITMENT');
        store.addCommitment({ account: b, itemCode: store.exactPart(body.itemCode)!, annualQty: body.annualQty, rep: user.name, rfqId: typeof body.rfqId === 'string' ? body.rfqId : null, note: typeof body.note === 'string' ? body.note.slice(0, 200) : null }, now());
      }
      return send(res, m === 'POST' ? 201 : 200, { now: now(), commitments: store.commitments(b, now()) });
    }
    // -- A3: orders, payments, partial cancellations, commitments, debit notes; A4: per-rep report --
    if (a === 'finance' && b === 'debit-notes' && !c && m === 'GET') {
      need(user, 'finance');
      return send(res, 200, { now: now(), debitNotes: store.debitNotes() });
    }
    if (a === 'finance' && b === 'reps' && !c && m === 'GET') {
      // A4: Finance-only. Sales never sees the report, the floor or another rep's figures.
      need(user, 'finance');
      return send(res, 200, { now: now(), reps: store.repReport(now()) });
    }
    if (a === 'orders' && !b && m === 'GET') {
      need(user, 'finance');
      const acct = new URL(req.url ?? '/', 'http://local').searchParams.get('account') ?? undefined;
      return send(res, 200, { now: now(), orders: store.orders(acct) });
    }
    if (a === 'orders' && b && c === 'payment' && m === 'POST') {
      need(user, 'finance');
      const body = await json(req);
      if (typeof body.paidDays !== 'number' || !Number.isInteger(body.paidDays) || body.paidDays < 0 || body.paidDays > 365) throw new HttpError(422, 'paidDays must be 0 to 365', 'BAD_DAYS');
      const r = store.recordPayment(b, body.paidDays, now(), user.name);
      if (!r.ok) throw new HttpError(r.code === 'NOT_FOUND' ? 404 : 409, r.code === 'NOT_FOUND' ? 'not found' : 'payment already recorded', r.code);
      return send(res, 200, { now: now(), debitNotes: r.debitNotes, order: store.orders().find((o) => o.orderRef === b) ?? null });
    }
    if (a === 'orders' && b && c === 'cancel' && m === 'POST') {
      // The buyer cancels part of an order (or Sales records it). A discount granted for the full quantity no longer holds (A3).
      need(user, 'customer', 'sales');
      const o = store.order(b);
      if (!o) throw new HttpError(404, 'not found');
      if (user.kind === 'customer') ownAccount(user, o.account);
      const body = await json(req);
      const r = store.cancelPart(b, body.quantity as number, now(), user.name);
      if (!r.ok) throw new HttpError(r.code === 'NOT_FOUND' ? 404 : 422, r.code === 'NOT_FOUND' ? 'not found' : 'Cancel 1 to one less than the ordered quantity', r.code);
      // The buyer sees its own new figures only; staff also see the debit note.
      if (user.kind === 'customer') return send(res, 200, { now: now(), order_ref: b, quantity: r.quantity, unit_price_inr: r.unitPrice, total_inr: r.quantity * r.unitPrice });
      return send(res, 200, { now: now(), orderRef: b, quantity: r.quantity, unitPrice: r.unitPrice, debitNote: r.debitNote });
    }
    if (a === 'customers' && b && c === 'commitments' && d && path[4] === 'settle' && m === 'POST') {
      need(user, 'finance');
      if (!store.account(b)) throw new HttpError(404, 'not found');
      const id = Number(d);
      const own = store.commitments(b, now()).some((x) => x.id === id);
      if (!own) throw new HttpError(404, 'not found');
      const r = store.settleCommitment(id, now(), user.name);
      if (!r.ok) throw new HttpError(r.code === 'NOT_FOUND' ? 404 : 409, r.code === 'NOT_FOUND' ? 'not found' : 'already settled', r.code);
      return send(res, 200, { now: now(), shortfall: r.shortfall, debitNotes: r.debitNotes, commitments: store.commitments(b, now()) });
    }
    if (a === 'customers' && b && c === 'group' && m === 'GET') {
      need(user, 'sales', 'finance');
      if (!store.account(b)) throw new HttpError(404, 'not found');
      return send(res, 200, { now: now(), group: store.groupView(b, now()) });
    }

    // -- Inventory --
    if (a === 'inventory' && !b && m === 'GET') {
      need(user, 'inventory');
      return send(res, 200, { now: now(), items: store.stockRows(now()), requests: views.stockRequests(), activeReservations: store.activeReservations() });
    }
    if (a === 'inventory' && b === 'reservations' && m === 'GET') {
      need(user, 'inventory');
      return send(res, 200, { now: now(), reservations: views.reservations() });
    }
    if (a === 'inventory' && b && c === 'confirm' && m === 'POST') {
      need(user, 'inventory');
      const code = store.exactPart(b);
      if (!code) throw new HttpError(404, 'not found');
      const body = await json(req);
      if (typeof body.onHand !== 'number' || !Number.isInteger(body.onHand) || body.onHand < 0) throw new HttpError(400, 'onHand must be a whole number');
      const r = store.confirmCount(code, body.onHand, now(), user.name);
      if (!r.ok) throw new HttpError(422, 'Count is below what is reserved and ordered', r.code);
      for (const q of store.rfqs()) {
        const s = stateOf(q);
        if (s.status === 'awaiting_inventory' && s.item?.itemCode === code) {
          store.audit(now(), q.rfqId, 'count_confirmed', { itemCode: code, onHand: body.onHand, user: user.name }, { actor: 'inventory' });
          await signal(q, stockConfirmedSignal, { itemCode: code }).catch(() => undefined);
        }
      }
      return send(res, 200, { now: now(), item: r.row });
    }
    if (a === 'inventory' && b && c === 'refresh' && m === 'POST') {
      need(user, 'sales', 'inventory');
      const code = store.exactPart(b);
      if (!code) throw new HttpError(404, 'not found');
      return send(res, 200, { now: now(), item: store.refreshFeed(code, now()) });
    }

    // -- Customer --
    if (a === 'customer' && b && c === 'messages' && m === 'GET') {
      ownAccount(user, b);
      return send(res, 200, { now: now(), account: accountOf(b), messages: views.messages(b, now()) });
    }
    if (a === 'customer' && b && c === 'messages' && m === 'POST') {
      ownAccount(user, b);
      const body = await json(req);
      if (body.channel !== 'mail' && body.channel !== 'chat') throw new HttpError(400, 'channel must be mail or chat');
      if (typeof body.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'text required');
      const text = body.text;
      const subject = typeof body.subject === 'string' ? body.subject.slice(0, 200) : undefined;
      const replyTo = typeof body.replyTo === 'string' ? body.replyTo : null;
      // 1. A reply to a message → that message's RFQ. 2. Chat → the RFQ waiting on this customer. 3. A new RFQ.
      let target: RfqRow | undefined;
      if (replyTo) {
        const orig = store.message(replyTo);
        if (!orig || orig.account !== b) throw new HttpError(404, 'not found');
        target = orig.rfqId ? store.rfq(orig.rfqId) : undefined;
      } else if (body.channel === 'chat') {
        target = store
          .rfqs()
          .filter((r) => r.account === b && ['needs_customer', 'sent', 'quote_expired'].includes(views.stage(stateOf(r), now())) && !stateOf(r).final)
          .sort((x, y) => y.updatedAt - x.updatedAt)[0];
      }
      const kind = target ? 'reply' : 'rfq';
      const messageId = store.addMessage(b, target?.rfqId ?? null, now(), 'in', { kind, mail: null, chat: text, text }, body.channel, replyTo);
      if (target) {
        store.audit(now(), target.rfqId, 'customer_message', { messageId, user: user.name }, { actor: 'customer' });
        const reply: CustomerReply = { messageId, at: now(), text };
        await signal(target, customerReplySignal, reply).catch((e) => {
          if (!(e instanceof HttpError)) throw e;
        });
        await waitSettled(target.rfqId, target.seq, 3000);
        return send(res, 201, { messageId, rfqId: target.rfqId });
      }
      const s = await startRfq({ account: b, channel: body.channel, text, ...(subject && { subject }), messageId });
      return send(res, 201, { messageId, rfqId: s.rfqId });
    }
    if (a === 'v1' && b === 'rfq' && !c && m === 'POST') {
      need(user, 'customer');
      const body = await json(req);
      const account = user.kind === 'customer' ? user.account : typeof body.account === 'string' ? body.account : '';
      if (!store.account(account)) throw new HttpError(422, 'unknown account', 'UNKNOWN_ACCOUNT');
      const request = { ...body };
      if (user.kind === 'professor') delete request.account; // professor acts as the body's account
      const rc = body.rival_claim as Record<string, unknown> | undefined;
      delete request.rival_claim;
      const claim =
        rc && typeof rc === 'object'
          ? {
              rival: typeof rc.rival === 'string' ? rc.rival.slice(0, 120) : null,
              rivalGstin: typeof rc.gstin === 'string' ? rc.gstin.slice(0, 20) : null,
              claimedPrice: typeof rc.unit_price_inr === 'number' && rc.unit_price_inr > 0 ? Math.round(rc.unit_price_inr) : null,
              attachmentText: typeof rc.attachment_text === 'string' ? rc.attachment_text.slice(0, 20_000) : null,
            }
          : undefined;
      const key = typeof body.rfq_id === 'string' ? body.rfq_id.slice(0, 80) : null;
      if (key) {
        const existing = store.rfqByClientKey(account, key);
        if (existing) return send(res, 200, buyerStatus(existing));
      }
      const s = await startRfq({ account, channel: 'api', request, clientKey: key, ...(claim && { claim }) });
      await waitSettled(s.rfqId, 0, 10_000);
      return send(res, 202, buyerStatus(rfqOr404(s.rfqId)));
    }
    if (a === 'v1' && b === 'rfq' && c && m === 'GET') {
      need(user, 'customer');
      const r = rfqOr404(c);
      ownAccount(user, r.account);
      const st = buyerStatus(r);
      return send(res, 200, { status: st.status, rfq_id: r.rfqId, quote_ref: r.quoteRef, message: lastOutbound(r) });
    }
    if (a === 'v1' && b === 'quotes' && c && (d === 'accept' || d === 'decline') && m === 'POST') {
      need(user, 'customer');
      const r = store.rfqByQuoteRef(c);
      if (!r) throw new HttpError(404, 'not found');
      ownAccount(user, r.account);
      const body = await json(req);
      const reason = d === 'decline' && (LOSS_REASONS as readonly string[]).includes(body.reason as string) ? (body.reason as (typeof LOSS_REASONS)[number]) : undefined;
      const msg = d === 'accept' ? 'We accept.' : 'We decline.';
      const messageId = store.addMessage(r.account, r.rfqId, now(), 'in', { kind: 'reply', mail: null, chat: msg, text: msg }, 'api', null);
      await signal(r, customerReplySignal, { messageId, at: now(), structured: { decision: d, ...(reason && { reason }) } });
      await waitSettled(r.rfqId, r.seq, settleMs);
      return send(res, 202, { status: buyerStatus(rfqOr404(r.rfqId)).status });
    }

    if (a === 'v1' && b === 'quotes' && c && d === 'counter' && m === 'POST') {
      // A buyer system's counter-offer, with or without a rival claim. The reply is always the same:
      // the offered price stands. Nothing here reads or changes a price.
      need(user, 'customer');
      const r = store.rfqByQuoteRef(c);
      if (!r) throw new HttpError(404, 'not found');
      ownAccount(user, r.account);
      const st = stateOf(r);
      if (views.stage(st, now()) !== 'sent' || !st.sent) throw new HttpError(409, 'no open quote to counter', 'NO_OPEN_QUOTE');
      const body = await json(req);
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);
      const str = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
      const counter: CounterOffer = {
        ...(num(body.unit_price_inr) !== undefined && { unitPrice: num(body.unit_price_inr) }),
        ...(str(body.rival, 120) && { rival: str(body.rival, 120) }),
        ...(str(body.rival_gstin, 20) && { rivalGstin: str(body.rival_gstin, 20) }),
        ...(num(body.rival_price_inr) !== undefined && { rivalPrice: num(body.rival_price_inr) }),
        ...(str(body.attachment_text, 20_000) && { attachment: str(body.attachment_text, 20_000) }),
      };
      const text = str(body.message, 2000) ?? (counter.unitPrice ? `Counter-offer: ₹${counter.unitPrice} each.` : 'Counter-offer.');
      const messageId = store.addMessage(r.account, r.rfqId, now(), 'in', { kind: 'reply', mail: null, chat: text, text }, 'api', null);
      const before = store.messagesForRfq(r.rfqId).length;
      await signal(r, customerReplySignal, { messageId, at: now(), text, structured: { counter } });
      const end = Date.now() + settleMs;
      while (Date.now() < end && store.messagesForRfq(r.rfqId).length <= before) await new Promise((x) => setTimeout(x, 50));
      const cur = stateOf(rfqOr404(r.rfqId));
      return send(res, 202, { status: 'quoted', quote_ref: r.quoteRef, unit_price_inr: cur.sent?.unitPrice ?? st.sent.unitPrice, message: lastOutbound(rfqOr404(r.rfqId)) });
    }

    // -- Audit, agents, usage, settings --
    if (a === 'audit' && b && m === 'GET') {
      need(user, 'sales', 'finance', 'inventory');
      const r = rfqOr404(b);
      const s = stateOf(r);
      const name = accountOf(r.account).name;
      return send(res, 200, {
        now: now(),
        quote: { rfqId: r.rfqId, quoteRef: r.quoteRef, workflowId: r.workflowId, accountName: name, model: views.detail(r, now()).technical.model },
        rows: views.audit(r.rfqId, name, forSales(user)),
        usage: views.usage(s),
        aiCalls: views.aiCalls(r.rfqId),
      });
    }
    if (a === 'agents' && !b && m === 'GET') {
      // P1: the prompt viewer is staff (and professor) only; never on the customer API.
      if (!isStaff(user)) throw new HttpError(403, 'staff only');
      const ids = deps.modelIds;
      return send(res, 200, {
        now: now(),
        agents: [
          describeIntake(ids?.intake ?? null),
          describeClarify(ids?.clarification ?? null),
          describeFinance(ids?.financeReferral ?? null),
          describeDecline(ids?.declineReader ?? null),
          describeEvidence(ids?.evidence ?? null),
        ],
      });
    }
    if (a === 'usage' && m === 'GET') {
      if (!isStaff(user)) throw new HttpError(403, 'staff only');
      if (!b) return send(res, 200, usageReport());
      const r = rfqOr404(b);
      const s = stateOf(r);
      return send(res, 200, { now: now(), rfqId: r.rfqId, quoteRef: r.quoteRef, accountName: accountOf(r.account).name, usage: views.usage(s), calls: views.aiCalls(r.rfqId) });
    }
    if (a === 'queue' && m === 'GET') {
      if (!isStaff(user)) throw new HttpError(403, 'staff only');
      const entries = await client.workflow
        .getHandle(deps.queueId ?? 'review-queue')
        .query(queueQuery)
        .catch(() => []);
      return send(res, 200, { now: now(), entries: user.kind === 'staff' ? entries.filter((e) => e.waitingOn === user.role) : entries });
    }
    if (a === 'settings') {
      if (!isStaff(user)) throw new HttpError(403, 'staff only');
      if (!b && m === 'GET') return send(res, 200, settings());
      if (b === 'clock' && c === 'advance' && m === 'POST') {
        const body = await json(req);
        const minutes = body.minutes;
        if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new HttpError(422, 'minutes must be 1 to 1440', 'BAD_MINUTES');
        const off = store.clockOffset() + minutes * 60_000;
        store.setSetting('clock_offset_ms', off);
        for (const r of store.rfqs()) {
          if (r.state?.final) continue;
          await client.workflow
            .getHandle(r.workflowId)
            .signal(clockSignal, { offsetMs: off })
            .catch(() => undefined);
        }
        await new Promise((x) => setTimeout(x, 300)); // let timers that are now due publish
        return send(res, 200, { now: now() });
      }
      if (b === 'stale-stock' && m === 'PUT') {
        const body = await json(req);
        if (typeof body.on !== 'boolean') throw new HttpError(400, 'on must be true or false');
        store.setStaleStock(body.on, now());
        return send(res, 200, settings());
      }
      if (b === 'test-requests' && c && d === 'load' && m === 'POST') {
        const t = TEST_REQUESTS.find((x) => x.id === c);
        if (!t) throw new HttpError(404, 'not found');
        const s = await startRfq('text' in t ? { account: t.account, channel: t.channel, text: t.text } : { account: t.account, channel: t.channel, request: t.request });
        return send(res, 201, { rfqId: s.rfqId, quoteRef: s.quoteRef, account: t.account });
      }
      if (b === 'reset' && m === 'POST') return send(res, 200, await reset());
    }
    throw new HttpError(404, 'not found');
  }

  const listener: RequestListener = async (req, res) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', 'access-control-allow-headers': 'content-type, x-demo-user, x-demo-code', 'access-control-max-age': '600' }).end();
      return;
    }
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      await route(req, res, path);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.code && { code: e.code }) });
      if (e instanceof SyntaxError) return send(res, 400, { error: 'invalid JSON' });
      if (e instanceof WorkflowExecutionAlreadyStartedError) return send(res, 409, { error: 'already started' });
      return send(res, 500, { error: e instanceof Error ? e.message : 'error' });
    }
  };
  return Object.assign(listener, { reset, orphaned });
}

export type Api = RequestListener & { reset: () => Promise<Settings>; orphaned: () => Promise<boolean> };

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  const v = JSON.parse(raw) as unknown;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'body must be a JSON object');
  return v as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
