import { z } from 'zod';
import type { FinanceCase } from './agents/grounding';
import { placeOrNull } from './agents/guardrails';
import { PRICE_REASONS, type PriceReason } from './agents/prompts';
import { BUDGET, DAY, POLICY, TRADES, WIN_RATE } from './config';
import type { Band, DeliveryOffer, DeliveryOption, IsoDate } from './contract';

/**
 * Business rules (DESIGN.md section 2). Pure functions only: the workflow bundle imports this file,
 * so nothing here may read the clock, the store or the environment.
 */

// ---- What the customer asked for ----

export const rfqRequestSchema = z.object({
  account: z.string().max(120).nullable(),
  partNumber: z.string().max(40).nullable(),
  partDescription: z.string().max(80).nullable(),
  quantity: z.number().int().nullable(),
  firm: z.boolean(),
  requestedUnitPrice: z.number().nullable(),
  priceReason: z.enum(PRICE_REASONS).nullable(),
  deliverBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  deliverTo: z.string().max(60).nullable(),
});
export type RfqRequest = z.infer<typeof rfqRequestSchema>;

export const EMPTY_REQUEST: RfqRequest = {
  account: null,
  partNumber: null,
  partDescription: null,
  quantity: null,
  firm: false,
  requestedUnitPrice: null,
  priceReason: null,
  deliverBy: null,
  deliverTo: null,
};

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null);

/**
 * Structured input (seed, `POST /v1/rfq`, API test request) is parsed by code, no agent. Accepts the
 * internal field names and the purchasing-software names (`part`, `quote_type`, `target_price_inr`, ...).
 * Unknown keys are dropped.
 */
export function parseStructured(input: unknown): RfqRequest {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const reason = r.priceReason ?? r.price_reason;
  const quoteType = r.quote_type ?? r.quoteType;
  const deliverBy = str(r.deliverBy ?? r.deliver_by, 10);
  return {
    account: str(r.account, 120),
    partNumber: str(r.partNumber ?? r.part, 40),
    partDescription: str(r.partDescription ?? r.description, 80),
    quantity: (() => {
      const q = num(r.quantity);
      return q !== null && Number.isInteger(q) ? q : null;
    })(),
    firm: r.firm === true || quoteType === 'firm',
    requestedUnitPrice: num(r.requestedUnitPrice ?? r.target_price_inr),
    priceReason: (PRICE_REASONS as readonly string[]).includes(reason as string) ? (reason as PriceReason) : null,
    deliverBy: deliverBy && /^\d{4}-\d{2}-\d{2}$/.test(deliverBy) ? deliverBy : null,
    deliverTo: placeOrNull(str(r.deliverTo ?? r.deliver_to, 60)),
  };
}

// ---- Catalogue and accounts ----

export interface Part {
  partNumber: string;
  description: string;
}

export interface AccountRef {
  code: string;
  name: string;
}

/** True when the request names an account other than the authenticated caller. Checked before any data is loaded. */
export function namesOtherAccount(req: RfqRequest, caller: AccountRef): boolean {
  if (!req.account) return false;
  const named = req.account.trim().toLowerCase();
  const name = caller.name.toLowerCase();
  if (!named) return false;
  return named !== caller.code.toLowerCase() && !name.includes(named) && !named.includes(name);
}

// ---- 2.1 Price bands ----

export interface ItemRules {
  itemCode: string;
  description: string;
  location: string;
  unitCost: number;
  minMarginPct: number;
  maxDiscountPct: number;
  partGroup: string; // win rates are computed over the part group
  clearance: boolean; // only a clearance item may be sold below cost
}

export const minPriceOf = (unitCost: number, minMarginPct: number) => Math.round(unitCost / (1 - minMarginPct / 100));
export const floorPriceOf = (contractPrice: number, maxDiscountPct: number) => Math.round(contractPrice * (1 - maxDiscountPct / 100));
/** The lowest price anyone may approve: the max-discount price, and never below cost unless the item is tagged clearance. */
export const lowestPriceOf = (contractPrice: number, item: Pick<ItemRules, 'maxDiscountPct' | 'unitCost' | 'clearance'>) =>
  item.clearance ? floorPriceOf(contractPrice, item.maxDiscountPct) : Math.max(floorPriceOf(contractPrice, item.maxDiscountPct), item.unitCost);

export function band(p: number, floorPrice: number, minPrice: number): Band {
  return p < floorPrice ? 'not_allowed' : p < minPrice ? 'needs_finance' : 'ok';
}

/** Margin in percent with one decimal. */
export const marginPct = (price: number, cost: number) => Math.round(((price - cost) / price) * 1000) / 10;

export interface FinanceApproval {
  itemCode: string;
  quantity: number;
  unitPrice: number;
  reason: string | null;
  at: number;
  by: string;
}

export type TargetSource = 'finance' | 'sales' | 'customer' | 'contract' | 'small_order' | 'cached' | 'trade';

// ---- H1: trades, the only way to a lower price ----

/** What the buyer offers on a request: a later delivery and faster payment (quantity is the request's own). */
export interface TradeInputs {
  leadDays: number | null; // days from today to the asked delivery date
  paymentDays: number | null; // days the buyer will pay in, if it offered faster payment
}
/** One published trade the price includes, and the condition the buyer must keep. */
export interface TradeApplied {
  kind: 'quantity' | 'later_date' | 'fast_payment';
  pct: number;
  condition: number; // quantity at least, days out at least, or pays within
}

/**
 * The published trade price (TRADES): the contract price less each trade the request carries, in a
 * fixed order (quantity, later date, faster payment). A step that would take the price below the
 * item's minimum is left out, so a trade never needs a person and never goes below the minimum.
 */
export function tradePrice(contractPrice: number, minPrice: number, quantity: number, t: TradeInputs | null): { price: number; applied: TradeApplied[] } {
  const applied: TradeApplied[] = [];
  const steps: TradeApplied[] = [];
  const tier = [...TRADES.quantity].reverse().find((x) => quantity >= x.minQty);
  if (tier) steps.push({ kind: 'quantity', pct: tier.pct, condition: tier.minQty });
  if (t?.leadDays != null && t.leadDays >= TRADES.laterDate.minDays) steps.push({ kind: 'later_date', pct: TRADES.laterDate.pct, condition: TRADES.laterDate.minDays });
  if (t?.paymentDays != null && t.paymentDays <= TRADES.fastPayment.maxDays) steps.push({ kind: 'fast_payment', pct: TRADES.fastPayment.pct, condition: TRADES.fastPayment.maxDays });
  let pct = 0;
  for (const st of steps) {
    const next = Math.round(contractPrice * (1 - (pct + st.pct) / 100));
    if (next < minPrice) continue;
    pct += st.pct;
    applied.push(st);
  }
  return { price: Math.round(contractPrice * (1 - pct / 100)), applied };
}

/** "pay in 7 days", "payment within 5 days", "advance payment": the payment days a buyer offers, else null. */
export function paymentDaysIn(text: string | null | undefined): number | null {
  if (!text) return null;
  if (/\b(advance payment|pay(?:ing)? in advance|payment in advance|cash in advance)\b/i.test(text)) return 0;
  const m = text.match(/\bpay(?:ment|s|ing)?\s+(?:with)?in\s+(\d{1,3})\s+days?\b/i);
  return m ? Number(m[1]) : null;
}

/** Days from `today` to `deliverBy`, or null. */
export const leadDaysOf = (deliverBy: IsoDate | null, today: IsoDate): number | null =>
  deliverBy ? Math.round((Date.parse(`${deliverBy}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY) : null;

/** Every price fact the rules used. Internal: never shown to the customer. */
export interface PriceFacts {
  itemCode: string;
  quantity: number;
  contractPrice: number;
  unitCost: number;
  minMarginPct: number;
  minPrice: number;
  maxDiscountPct: number;
  floorPrice: number;
  target: number;
  targetSource: TargetSource;
  band: Band;
  smallOrder: boolean;
  /** Discounts are frozen for the buyer group (probing), or the standing price holds (item 16). */
  frozen: boolean;
  /** H1: the contract price less the trades the request carries; what a person's discount is measured from. */
  basePrice: number;
  trades: TradeApplied[];
  policyVersion: string;
}

export interface PriceInputs {
  item: ItemRules;
  contractPrice: number;
  quantity: number;
  approval: FinanceApproval | null;
  salesPrice: number | null;
  askedPrice: number | null;
  /** A quote for the same account, item, quantity and date that is still valid: re-asking returns its price. */
  cachedPrice?: number | null;
  /** Discounts frozen for the buyer group, or a Finance timeout on a claim quote: contract price only. */
  frozen?: boolean;
  /** The sent price of this quote (L1): a Sales price below it needs Finance even inside the Sales band. */
  lockedPrice?: number | null;
  /** H1: the trades on the request (later date, faster payment); quantity comes from `quantity`. */
  trade?: TradeInputs | null;
}

export const isSmallOrder = (quantity: number, contractPrice: number) => quantity * contractPrice < BUDGET.smallOrderBelowInr;

/**
 * 2.1: the price the rules test, first match wins, and its band. A rival price a buyer claims is not
 * an input: no pricing function takes a claim or an alert (ADVERSARIAL 13).
 */
export function priceFacts(p: PriceInputs): PriceFacts {
  const { item, contractPrice, quantity } = p;
  const minPrice = minPriceOf(item.unitCost, item.minMarginPct);
  const floorPrice = lowestPriceOf(contractPrice, item);
  const small = isSmallOrder(quantity, contractPrice);
  const frozen = p.frozen === true;
  const locked = p.lockedPrice ?? null;
  // H1: a trade is the only way below the contract price without a person. None for a frozen group, a small order or a clearance item.
  const t = frozen || small || item.clearance ? { price: contractPrice, applied: [] as TradeApplied[] } : tradePrice(contractPrice, minPrice, quantity, p.trade ?? null);
  const base = t.price;
  let target = base;
  let targetSource: TargetSource = t.applied.length ? 'trade' : 'contract';
  const approval = p.approval && p.approval.itemCode === item.itemCode && p.approval.quantity === quantity ? p.approval : null;
  if (approval) {
    target = approval.unitPrice;
    targetSource = 'finance';
  } else if (frozen) {
    // Frozen group, or the standing price after a Finance timeout (item 16): the sent price, else the
    // contract price. A cached discount or a customer ask is not used; a Sales price only at or above it.
    target = locked ?? contractPrice;
    targetSource = locked !== null ? 'sales' : 'contract';
    if (p.salesPrice !== null && p.salesPrice >= target) {
      target = p.salesPrice;
      targetSource = 'sales';
    }
  } else if (p.cachedPrice != null) {
    target = p.cachedPrice;
    targetSource = 'cached';
  } else if (p.salesPrice !== null) {
    target = p.salesPrice;
    targetSource = 'sales';
  } else if (p.askedPrice !== null && p.askedPrice < base && (small || band(p.askedPrice, floorPrice, minPrice) !== 'ok')) {
    // H1: the first price is the best. An ask at or above the minimum is not granted by code: the quote
    // is the contract (or trade) price, and only the rep may type a lower one. An ask below the minimum
    // is a discount request: Finance decides (or nobody can, below the max discount). A small order's ask
    // is ignored below (13).
    target = p.askedPrice;
    targetSource = 'customer';
  }
  let b = band(target, floorPrice, minPrice);
  // A Finance approval covers its price. A cached price does not: a cached price below the minimum goes back to Finance.
  if (b === 'needs_finance' && targetSource === 'finance') b = 'ok';
  // The sent price stands: it was approved when it was sent.
  if (b === 'needs_finance' && frozen && locked !== null && target === locked) b = 'ok';
  const belowLock = locked !== null && targetSource === 'sales' && target < locked;
  if (b === 'ok' && belowLock) b = 'needs_finance';
  // 13: a small order never goes to Finance, and a customer's ask never sets its price: the asked price
  // is ignored and the contract price (or the sent price) is quoted, so asking reveals no limit.
  if (small && targetSource === 'customer') {
    target = locked ?? contractPrice;
    targetSource = 'small_order';
    b = 'ok';
  }
  // A Sales or cached price below the minimum on a small order: the lowest price that needs nobody (never below a sent price).
  if (b === 'needs_finance' && small) {
    target = locked !== null ? Math.max(minPrice, locked) : minPrice;
    targetSource = 'small_order';
    b = 'ok';
  }
  return {
    itemCode: item.itemCode,
    quantity,
    contractPrice,
    unitCost: item.unitCost,
    minMarginPct: item.minMarginPct,
    minPrice,
    maxDiscountPct: item.maxDiscountPct,
    floorPrice,
    target,
    targetSource,
    band: b,
    smallOrder: small,
    frozen,
    basePrice: base,
    // The trades stay in the price when a person goes lower still (their conditions still bind the buyer).
    trades: target <= base ? t.applied : [],
    policyVersion: POLICY.version,
  };
}

export type ClarifyReason = 'account' | 'part' | 'quantity';

export type Evaluation =
  | { kind: 'clarify'; reason: ClarifyReason; options: Part[] }
  | { kind: 'blocked'; reason: 'NO_CONTRACT_PRICE'; item: ItemRules; quantity: number }
  | { kind: 'blocked'; reason: 'BELOW_MAX_DISCOUNT'; item: ItemRules; price: PriceFacts }
  | { kind: 'finance'; item: ItemRules; price: PriceFacts }
  | { kind: 'ok'; item: ItemRules; price: PriceFacts };

/** Valid quantity: whole number from 1 to 100,000. */
export const validQuantity = (q: unknown): q is number => typeof q === 'number' && Number.isInteger(q) && q >= 1 && q <= 100_000;

/**
 * Fixed rules: account, part, quantity, contract price, price band. No model decides any of these.
 * The caller loads `item` and `contractPrice` only after the account and part checks pass.
 */
export interface EvalContext {
  caller: AccountRef;
  matches: Part[];
  item: ItemRules | null;
  contractPrice: number | null;
  approval: FinanceApproval | null;
  salesPrice: number | null;
  cachedPrice?: number | null;
  frozen?: boolean;
  lockedPrice?: number | null;
  trade?: TradeInputs | null;
}

export function evaluate(req: RfqRequest, ctx: EvalContext): Evaluation {
  if (namesOtherAccount(req, ctx.caller)) return { kind: 'clarify', reason: 'account', options: [] };
  if (ctx.matches.length !== 1 || !ctx.item) return { kind: 'clarify', reason: 'part', options: ctx.matches };
  if (!validQuantity(req.quantity)) return { kind: 'clarify', reason: 'quantity', options: [ctx.matches[0]!] };
  if (ctx.contractPrice === null) return { kind: 'blocked', reason: 'NO_CONTRACT_PRICE', item: ctx.item, quantity: req.quantity };
  const price = priceFacts({
    item: ctx.item,
    contractPrice: ctx.contractPrice,
    quantity: req.quantity,
    approval: ctx.approval,
    salesPrice: ctx.salesPrice,
    askedPrice: req.requestedUnitPrice,
    cachedPrice: ctx.cachedPrice ?? null,
    frozen: ctx.frozen ?? false,
    lockedPrice: ctx.lockedPrice ?? null,
    trade: ctx.trade ?? null,
  });
  if (price.band === 'not_allowed') return { kind: 'blocked', reason: 'BELOW_MAX_DISCOUNT', item: ctx.item, price };
  if (price.band === 'needs_finance') return { kind: 'finance', item: ctx.item, price };
  return { kind: 'ok', item: ctx.item, price };
}

// ---- Win rate at a price (DECISIONS 1 and 9) ----

/** One closed quote of the part group: Dhruva's price, the list (contract) price it was against, won or lost. */
export interface OutcomeRow {
  groupId: string;
  unitPrice: number;
  listPrice: number;
  won: boolean;
  closedOn: IsoDate;
}

/** 90% Wilson score interval for `won` of `n`, as fractions. */
export function wilson(won: number, n: number, z: number = WIN_RATE.z): [number, number] {
  if (n <= 0) return [0, 1];
  const p = won / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface WinRate {
  price: number;
  quotes: number; // matching quotes after the per-group cap
  won: number;
  enough: boolean; // quotes >= WIN_RATE.minQuotes
  pct: number | null; // whole percent; null when not enough data
  lowPct: number | null;
  highPct: number | null;
}

/**
 * Win rate at `price` against `listPrice`. `rows` are closed quotes of the same part group in the last
 * 12 months, newest first (the store filters by group and date). A row matches when its price as a
 * share of its list price is within ±5% of ours, so items of one group with different list prices
 * compare fairly. Each buyer group adds at most WIN_RATE.groupCap matching rows, so one group cannot
 * move the range by declining on purpose.
 */
export function winRateAt(price: number, listPrice: number, rows: OutcomeRow[]): WinRate {
  const t = price / listPrice;
  const perGroup = new Map<string, number>();
  let quotes = 0;
  let won = 0;
  for (const r of rows) {
    const ratio = r.unitPrice / r.listPrice;
    if (Math.abs(ratio - t) > (WIN_RATE.windowPct / 100) * t) continue;
    const used = perGroup.get(r.groupId) ?? 0;
    if (used >= WIN_RATE.groupCap) continue;
    perGroup.set(r.groupId, used + 1);
    quotes += 1;
    if (r.won) won += 1;
  }
  const enough = quotes >= WIN_RATE.minQuotes;
  if (!enough) return { price, quotes, won, enough, pct: null, lowPct: null, highPct: null };
  const [lo, hi] = wilson(won, quotes);
  return { price, quotes, won, enough, pct: Math.round((won / quotes) * 100), lowPct: Math.round(lo * 100), highPct: Math.round(hi * 100) };
}

/** Expected gross profit = gross profit at the price x win rate at that price, as a range. Whole rupees. */
export function expectedProfit(profit: number, w: WinRate): { point: number; low: number; high: number } | null {
  if (!w.enough || w.pct === null || w.lowPct === null || w.highPct === null) return null;
  return { point: Math.round((profit * w.pct) / 100), low: Math.round((profit * w.lowPct) / 100), high: Math.round((profit * w.highPct) / 100) };
}

// ---- New-customer rule (DECISIONS 2, 3, 4) ----

export interface DiscountRule {
  newCustomer: boolean; // fewer than 3 paid orders
  orderValue: number; // at the price the customer pays
  threshold: number; // ₹10,00,000
  committed: boolean; // Sales recorded a year's volume for this account and item
  allowed: boolean; // a below-minimum price may be approved
}

export function discountRule(paidOrders: number, orderValue: number, committed: boolean): DiscountRule {
  const newCustomer = paidOrders < POLICY.newCustomerPaidOrders;
  const threshold = POLICY.newCustomerOrderThreshold;
  return { newCustomer, orderValue, threshold, committed, allowed: !newCustomer || orderValue >= threshold || committed };
}

// ---- Finance facts ----

/** The facts the finance referral agent receives (fact list in src/agents/grounding.ts). */
export type FinanceFacts = FinanceCase;

export interface CustomerFacts {
  orders: number;
  lifetimeRevenue: number;
  avgPaymentDays: number | null;
  termsDays: number | null;
  overdueInvoices: number;
  discountedOrders: number;
}

export function financeFacts(
  accountName: string,
  p: PriceFacts,
  requestedBy: 'customer' | 'sales',
  priceReason: PriceReason | null,
  extra: { atRequested: WinRate; atContract: WinRate; customer: CustomerFacts; rule: DiscountRule },
): FinanceFacts {
  const profitAtRequested = (p.target - p.unitCost) * p.quantity;
  const profitAtContract = (p.contractPrice - p.unitCost) * p.quantity;
  const er = expectedProfit(profitAtRequested, extra.atRequested);
  const ec = expectedProfit(profitAtContract, extra.atContract);
  const r = extra.atRequested;
  const c = extra.atContract;
  return {
    accountName,
    itemCode: p.itemCode,
    quantity: p.quantity,
    requestedBy,
    priceReason,
    requestedUnitPrice: p.target,
    contractPrice: p.contractPrice,
    unitCost: p.unitCost,
    minMarginPct: p.minMarginPct,
    minPrice: p.minPrice,
    maxDiscountPct: p.maxDiscountPct,
    floorPrice: p.floorPrice,
    marginAtRequestedPct: marginPct(p.target, p.unitCost),
    marginAtContractPct: marginPct(p.contractPrice, p.unitCost),
    totalAtRequested: p.target * p.quantity,
    totalAtContract: p.contractPrice * p.quantity,
    profitAtRequested,
    profitAtContract,
    quotesAtRequested: r.quotes,
    wonAtRequested: r.won,
    winRateAtRequestedPct: r.pct,
    winRateAtContractPct: c.pct,
    expectedProfitAtRequested: er?.point ?? null,
    expectedProfitAtContract: ec?.point ?? null,
    winRateAtRequestedLowPct: r.lowPct,
    winRateAtRequestedHighPct: r.highPct,
    winRateAtContractLowPct: c.lowPct,
    winRateAtContractHighPct: c.highPct,
    expectedProfitAtRequestedLow: er?.low ?? null,
    expectedProfitAtRequestedHigh: er?.high ?? null,
    expectedProfitAtContractLow: ec?.low ?? null,
    expectedProfitAtContractHigh: ec?.high ?? null,
    quotesAtContract: c.quotes,
    orders: extra.customer.orders,
    lifetimeRevenue: extra.customer.lifetimeRevenue,
    avgPaymentDays: extra.customer.avgPaymentDays,
    termsDays: extra.customer.termsDays,
    overdueInvoices: extra.customer.overdueInvoices,
    discountedOrders: extra.customer.discountedOrders,
    newCustomer: extra.rule.newCustomer,
    orderValue: extra.rule.orderValue,
    newCustomerOrderThreshold: extra.rule.threshold,
    yearVolumeCommitted: extra.rule.committed,
    newCustomerDiscountAllowed: extra.rule.allowed,
  };
}

/** What the new-customer rule needs to judge a price: it is evaluated at the price actually approved (DECISIONS 3). */
export interface RuleInputs {
  newCustomer: boolean;
  committed: boolean;
  quantity: number;
  threshold: number;
}

/** The new-customer rule's inputs from a Finance case's facts. */
export const ruleInputsOf = (f: Pick<FinanceFacts, 'newCustomer' | 'yearVolumeCommitted' | 'quantity' | 'newCustomerOrderThreshold'>): RuleInputs => ({
  newCustomer: f.newCustomer,
  committed: f.yearVolumeCommitted,
  quantity: f.quantity,
  threshold: f.newCustomerOrderThreshold,
});

/**
 * A discount decision (Finance, or the rep after the Finance deadline), 8.3. Null when valid. Every
 * discount (a price below the contract price) needs a reason of 3 to 300 characters; the cited fact
 * ids are checked by `checkReasonCites` (grounding.ts). Below the minimum, the new-customer rule must
 * allow a discount at the order value of the approved price.
 */
export function checkFinancePrice(
  unitPrice: unknown,
  reason: unknown,
  r: { contractPrice: number; minPrice: number; floorPrice: number },
  rule: RuleInputs | null = null,
): { code: string; error: string } | null {
  if (typeof unitPrice !== 'number' || !Number.isInteger(unitPrice) || unitPrice <= 0) return { code: 'BAD_PRICE', error: 'unitPrice must be a whole number of rupees' };
  if (unitPrice < r.floorPrice) return { code: 'BELOW_MAX_DISCOUNT', error: `Below the max discount price ${inr(r.floorPrice)}` };
  if (unitPrice > r.contractPrice) return { code: 'ABOVE_CONTRACT', error: `Above the contract price ${inr(r.contractPrice)}` };
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (unitPrice < r.contractPrice && (why.length < 3 || why.length > 300)) return { code: 'REASON_REQUIRED', error: 'Give a reason (3 to 300 characters) for every discount' };
  if (unitPrice < r.minPrice && rule && rule.newCustomer && !rule.committed && unitPrice * rule.quantity < rule.threshold)
    return { code: 'NEW_CUSTOMER_RULE', error: `New customer: no discount below the minimum unless the order is ${inr(rule.threshold)} or more at the approved price, or Sales committed a year's volume` };
  return null;
}

// ---- Business hours (Finance deadline) ----

const isWorkday = (iso: IsoDate) => new Date(`${iso}T00:00:00Z`).getUTCDay() !== 0; // Monday to Saturday

/** `hours` business hours after `from` (IST, 09:00 to 18:00, Monday to Saturday). */
export function addBusinessHours(from: number, hours: number): number {
  const { start, end } = POLICY.businessHours;
  let left = hours * 3_600_000;
  let t = from;
  for (let guard = 0; guard < 400; guard++) {
    const day = istDate(t);
    const open = istAt(day, start);
    const close = istAt(day, end);
    if (!isWorkday(day) || t >= close) {
      t = istAt(addDays(day, 1), start);
      continue;
    }
    if (t < open) t = open;
    const room = close - t;
    if (left <= room) return t + left;
    left -= room;
    t = istAt(addDays(day, 1), start);
  }
  return t;
}

// ---- Time and money for people (Asia/Kolkata has no daylight saving: fixed +05:30) ----

const IST_MS = 330 * 60_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ist = (ms: number) => new Date(ms + IST_MS);

export const istDate = (ms: number): IsoDate => ist(ms).toISOString().slice(0, 10);
export const fmtTime = (ms: number) => ist(ms).toISOString().slice(11, 16);
export function fmtDate(d: IsoDate | number): string {
  const iso = typeof d === 'number' ? istDate(d) : d;
  const [, m, day] = iso.split('-');
  return `${Number(day)} ${MONTHS[Number(m) - 1]}`;
}
export const monthName = (iso: IsoDate) => MONTHS[Number(iso.slice(5, 7)) - 1]!;
export function addDays(iso: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
/** Epoch ms of hh:mm IST on the given date. */
export const istAt = (iso: IsoDate, hour: number, minute = 0) => Date.parse(`${iso}T00:00:00Z`) - IST_MS + (hour * 60 + minute) * 60_000;

/** ₹ with Indian grouping: ₹2,00,000. */
export function inr(n: number): string {
  const neg = n < 0;
  const [whole, frac] = Math.abs(n).toFixed(Number.isInteger(n) ? 0 : 2).split('.');
  const w = whole!;
  const grouped = w.length <= 3 ? w : `${w.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${w.slice(-3)}`;
  return `${neg ? '-' : ''}₹${grouped}${frac ? `.${frac}` : ''}`;
}

// ---- 2.3 Delivery and short stock ----

export interface PoFacts {
  poId: string;
  quantity: number;
  reserved: number;
  arrivesOn: IsoDate;
  supplierTatDays: number;
}

/** Delivery date for stock on hand: the asked date if given and not in the past, else today + lead days. */
export function stockDeliveryDate(deliverBy: IsoDate | null, now: number): IsoDate {
  const today = istDate(now);
  return deliverBy && deliverBy >= today ? deliverBy : addDays(today, POLICY.leadDays);
}

export function buildOffer(quantity: number, available: number, po: PoFacts | null, deliverBy: IsoDate | null, now: number): { offer: DeliveryOffer; options: DeliveryOption[] } {
  const date = stockDeliveryDate(deliverBy, now);
  const readyOn = po ? addDays(po.arrivesOn, POLICY.handlingDays) : null;
  const free = po ? po.quantity - po.reserved : 0;
  const options: DeliveryOption[] = [];
  const avail = Math.max(0, available);
  if (po && readyOn && avail > 0 && free >= quantity - avail) {
    options.push({ id: 'split', parts: [{ quantity: avail, on: date, source: 'stock' }, { quantity: quantity - avail, on: readyOn, source: 'po' }] });
  }
  if (po && readyOn && free >= quantity) options.push({ id: 'full', parts: [{ quantity, on: readyOn, source: 'po' }] });
  return {
    offer: {
      requestedDate: deliverBy,
      availableNow: avail,
      po: po ? { id: po.poId, quantity: po.quantity, arrivesOn: po.arrivesOn, supplierTatDays: po.supplierTatDays } : null,
      handlingDays: POLICY.handlingDays,
      readyOn,
    },
    options,
  };
}

export const stockOption = (quantity: number, deliverBy: IsoDate | null, now: number): DeliveryOption => ({
  id: 'stock',
  parts: [{ quantity, on: stockDeliveryDate(deliverBy, now), source: 'stock' }],
});

/** 2.4: PO-backed and indicative quotes are valid until 17:00 today, or 17:00 tomorrow after 17:00. */
export function closeOfBusiness(now: number): number {
  const today = istAt(istDate(now), POLICY.businessCloseHour);
  return now < today ? today : istAt(addDays(istDate(now), 1), POLICY.businessCloseHour);
}

/** "{10:10} today", "5 pm today", "5 pm on 24 Nov". */
export function validText(validUntil: number, now: number): string {
  const sameDay = istDate(validUntil) === istDate(now);
  const t = fmtTime(validUntil);
  const label = t === '17:00' ? '5 pm' : t;
  return sameDay ? `${label} today` : `${label} on ${fmtDate(validUntil)}`;
}

/** "5 Dec, Pune" · "20 on 28 Nov, 100 on 4 Dec" · "All 120 on 4 Dec". */
export function deliveryText(o: DeliveryOption, place: string | null): string {
  if (o.id === 'stock') return `${fmtDate(o.parts[0]!.on)}${place ? `, ${place}` : ''}`;
  if (o.id === 'full') return `All ${o.parts[0]!.quantity} on ${fmtDate(o.parts[0]!.on)}`;
  return o.parts.map((p) => `${p.quantity} on ${fmtDate(p.on)}`).join(', ');
}
