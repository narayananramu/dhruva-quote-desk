/** Fixed policy. Fixed code, not model judgement. Prices and costs are per item and account (store). */
export const POLICY = {
  version: '2026-11',
  timeZone: 'Asia/Kolkata',
  stockFreshMs: 5 * 60_000, // a count older than this cannot back a firm date
  holdMs: 10 * 60_000, // a stock hold lasts this long (durable timer)
  leadDays: 2, // delivery from stock = today + leadDays when no date is asked
  handlingDays: 2, // PO arrival + handlingDays = ready to ship
  businessCloseHour: 17, // PO-backed and indicative quotes are valid until 17:00
  companyMarginPct: 18,
  lowStockBelow: 50,
  businessHours: { start: 9, end: 18 }, // IST, Monday to Saturday
  financeDeadlineBusinessHours: 4, // then the rep decides on the same figures (except claim quotes and frozen groups)
  newCustomerPaidOrders: 3, // fewer paid orders than this: a new customer
  newCustomerOrderThreshold: 1_000_000, // ₹10 lakh at the price the customer pays
} as const;

/** Win rate at a price (DECISIONS 1 and 9): 90% Wilson interval over matching closed quotes. */
export const WIN_RATE = {
  windowPct: 5, // a past quote matches when its price, as a share of its list price, is within ±5% of ours
  months: 12,
  minQuotes: 20, // fewer: "not enough data"
  z: 1.6449, // 90% two-sided
  groupCap: 5, // each buyer group adds at most its 5 most recent matching quotes (ADVERSARIAL B, threat 5)
} as const;

/** Probe detection (DECISIONS 11): per buyer group, in a rolling window. Reaching a limit freezes discounts. */
export const PROBE = {
  windowDays: 7,
  counters: 3, // counter-offers on sent quotes
  requotes: 3, // repeat requests for the same part (the first request is not a re-quote)
  reopens: 3, // declines followed by a reopen
  promptLeaks: 3, // attempts to read the agents' instructions
  freezeDays: 30,
} as const;

/**
 * H1: the published trades. A counter never lowers a price; the only way to a lower price is a
 * visible trade on a new request. Each step applies only while the price stays at or above the
 * item's minimum (a step that would go below is left out). Frozen groups, small orders and clearance
 * items get no trade.
 */
export const TRADES = {
  version: 'trades-2026-11',
  quantity: [
    { minQty: 500, pct: 1 },
    { minQty: 1000, pct: 2 },
  ],
  laterDate: { minDays: 30, pct: 1 }, // delivery at least 30 days after the request
  fastPayment: { maxDays: 7, pct: 1 }, // pays within 7 days of invoice
} as const;

/**
 * A2: stock holds per buyer group. A hold is an active reservation (unsent hold or sent quote).
 * Every 3 expiries without an order in 30 days halve the limits; a group not in good standing
 * (an overdue invoice or debit note, or a confirmed fake claim) gets no hold.
 */
export const HOLDS = {
  maxOpen: 3, // RFQs holding stock at once
  maxQty: 2_000, // units held at once
  maxValueInr: 2_000_000, // ₹20 lakh held at once, at contract prices
  expiryWindowDays: 30,
  expiriesPerStep: 3,
} as const;

/** A3: on a rep's commitment shortfall, this share of the clawed-back discount comes off the rep's commission. */
export const CLAWBACK = { commissionPct: 10 } as const;

export const DAY = 86_400_000;

/** How long the workflow waits durably for each person before giving up. */
export const WAITS = { customer: 3 * DAY, sales: 1 * DAY, finance: 2 * DAY, inventory: 1 * DAY, reopen: 7 * DAY } as const;

/** Reset puts the demo clock here: 23 Nov 2026 10:00 IST. */
export const DEMO_START = Date.parse('2026-11-23T10:00:00+05:30'); // 1795408200000

export const TASK_QUEUE = 'quotes';
export const REVIEW_QUEUE_ID = 'review-queue';

/**
 * AI usage and cost budget (DESIGN.md section 13). Plain numbers so the workflow bundle can import
 * them; the env-dependent price table lives in src/usage.ts (activities and API only).
 */
export const BUDGET = {
  tokenCapPerRfq: 40_000, // on reaching it no further agent step runs; the RFQ goes to Sales
  smallOrderBelowInr: 10_000, // orders under this take the cheap path
  smallOrderClarifications: 1, // at most one template clarification on the cheap path
  sameQuestionMax: 2, // the same clarification at most twice; then Sales reads the request
} as const;

/** Defaults for the price table and compute estimate; every value is env-overridable (src/usage.ts). */
export const COST_DEFAULTS = {
  shipInrPerMTokens: 410, // shipping (production) model, blended input and output
  openWeightInrPerMTokens: 25, // open-weight model on our own hardware
  mockInrPerMTokens: 0, // deterministic demo model
  computeInrPerRfq: 1, // Temporal and server cost of one typical RFQ
  actionsPerRfq: 40, // Temporal actions in one typical RFQ (= one RFQ-equivalent)
  shipModel: 'openai:gpt-5-mini',
  openWeightModel: 'local:qwen3:8b',
} as const;
