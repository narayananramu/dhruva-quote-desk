// Copy of src/contract.ts (DESIGN.md 8.2, 13.4 and 14). Keep in step with the backend.
export type Ms = number;        // epoch ms on the demo clock
export type IsoDate = string;   // 'YYYY-MM-DD', Asia/Kolkata
export type Role = 'sales' | 'finance' | 'inventory' | 'customer';
export type Channel = 'mail' | 'chat' | 'api' | 'phone';
export type PriceReason = 'competitor' | 'volume' | 'budget' | 'other';
export type LossReason = 'delivery_date' | 'price' | 'competitor' | 'specification' | 'other';
export type Band = 'ok' | 'needs_finance' | 'not_allowed';

export interface Account { code: string; name: string; email: string }
export interface Session { user: string; roles: Role[]; accounts: Account[]; salesRep: string; now: Ms }

export type Stage =
  | 'reading'           // intake, rules or send in progress
  | 'needs_customer'    // a question is with the customer
  | 'ready'             // stock held, safe to send
  | 'stale'             // count is old: ask Operations
  | 'with_inventory'    // Operations asked
  | 'hold_expired'      // reservation ran out before sending
  | 'short'             // not enough stock: pick a delivery
  | 'with_finance'
  | 'finance_rejected'
  | 'blocked'           // asked price below the max discount, or no contract price
  | 'sent'
  | 'quote_expired'     // validity ended; lateAcceptAt set if the customer then tried to accept
  | 'ordered'
  | 'lost'
  | 'closed'            // a wait ran out
  | 'failed'
  | 'needs_sales';      // 13: AI budget used up, or a small order needs a person; Sales reads the request

export type SalesActionType = 'send' | 'change' | 'question' | 'ask_inventory' | 'reserve' | 'reopen' | 'tag_loss';
export type SalesAction =
  | { type: 'send'; draftVersion: number; delivery?: 'split' | 'full' }
  | { type: 'change'; quantity?: number; unitPrice?: number; deliverBy?: IsoDate; itemCode?: string; reason: string; commitAnnualQty?: number }   // commitAnnualQty: the rep's one-year volume commitment, stored on the account
  | { type: 'question'; text: string }
  | { type: 'ask_inventory' }
  | { type: 'reserve' }
  | { type: 'reopen'; unitPrice: number; delivery: 'stock' | 'split' | 'full'; reason?: string }   // below the sent price: goes to Finance (L1)
  | { type: 'tag_loss'; reason: LossReason };

export interface QuoteSummary {
  rfqId: string; quoteRef: string; account: Account;
  itemCode: string | null; quantity: number | null; total: number | null;   // total at the current target price
  stage: Stage; revision: number; needsAnswer: boolean;                    // true when customerReply is waiting for Sales
  receivedAt: Ms; updatedAt: Ms;
  usage: UsageView;                                                       // 13: AI and compute cost of this RFQ so far
}

/** Win rate at one price from matching past quotes (90% Wilson interval). Staff only, never to customers. */
export interface WinRateView {
  price: number;
  quotes: number; won: number;                    // matching quotes after the per-group cap
  enough: boolean;                                // quotes >= 20; false shows "not enough data"
  pct: number | null; lowPct: number | null; highPct: number | null;
  expectedProfit: { point: number; low: number; high: number } | null;  // gross profit x win rate
}

export interface PriceView {
  unitPrice: number; total: number;             // current target price and quantity × price
  contractPrice: number; contractTotal: number;
  unitCost: number; marginPct: number; profit: number;   // at unitPrice; marginPct has one decimal
  minMarginPct: number; minPrice: number;
  maxDiscountPct: number | null;               // Finance-only, like floorPrice: null when Sales reads the quote
  floorPrice: number | null;                    // the max-discount price is Finance-only: null when Sales reads the quote
  band: Band; policyVersion: string;
  winRate: WinRateView | null;                  // at unitPrice
  winRateAtContract: WinRateView | null;
  targetSource: 'finance' | 'sales' | 'customer' | 'contract' | 'small_order' | 'cached' | 'trade';
  frozen: boolean;                              // discounts frozen for the buyer group, or the standing price holds
  basePrice: number;                            // H1: contract price less the published trades on the request
  trades: TradeApplied[];                       // H1: trades in the price (quantity tier, later date, faster payment)
}
/** H1: a published trade in the price and the condition the buyer keeps (quantity at least, days out at least, pays within). */
export interface TradeApplied { kind: 'quantity' | 'later_date' | 'fast_payment'; pct: number; condition: number }
export interface StockView {
  itemCode: string; location: string;
  onHand: number; reserved: number; ordered: number; available: number;
  countedAt: Ms; countOld: boolean; needed: number; enough: boolean;
}
export interface DeliveryPart { quantity: number; on: IsoDate; source: 'stock' | 'po' }
export interface DeliveryOption { id: 'stock' | 'split' | 'full'; parts: DeliveryPart[] }
export interface DeliveryOffer {
  requestedDate: IsoDate | null; availableNow: number;
  po: { id: string; quantity: number; arrivesOn: IsoDate; supplierTatDays: number } | null;
  handlingDays: number; readyOn: IsoDate | null;
}
export interface TraceStep {
  at: Ms; kind: 'agent' | 'code' | 'human' | 'timer';
  title: string; note: string; text: string;
  model?: string; promptVersion?: string; fallback?: boolean;
}

export interface QuoteDetail extends QuoteSummary {
  workflowId: string; channel: Channel; caller: string | null; salesRep: string;
  draftVersion: number;
  requestText: string | null;                    // what the customer wrote (staff only)
  item: { code: string; description: string; location: string; clearance: boolean } | null;
  newCustomer: boolean;                          // fewer than 3 paid orders: a discount below the minimum needs the Rs 10 lakh order or a year's volume
  wants: { firm: boolean; deliverBy: IsoDate | null; deliverTo: string | null; unitPrice: number | null; priceReason: PriceReason | null; paymentDays: number | null };
  holdLimited: 'HOLD_LIMIT' | 'NOT_IN_GOOD_STANDING' | null;   // A2: no stock held for this RFQ; the quote goes out indicative
  acceptedIndicativeAt: Ms | null;   // A2: the buyer accepted an indicative quote; the firm quote has not gone out yet
  stockPriority: boolean;                        // H1: the buyer has not countered on this RFQ: first call on short stock
  price: PriceView | null;                       // null until item and quantity are known
  stock: StockView | null;                       // live, read at request time
  hold: { quantity: number; expiresAt: Ms } | null;
  delivery: DeliveryOption | null;               // what is or will be offered
  deliveryOffer: DeliveryOffer | null;           // stage 'short', and 'lost' when the item is short
  deliveryOptions: DeliveryOption[];             // choices for 'short' (send) and 'lost' (reopen); else []
  question: { text: string; by: 'agent' | 'sales'; at: Ms } | null;
  customerReply: { text: string; at: Ms; answered?: boolean } | null; // a reply Sales has not acted on; answered: code already replied
  finance: {
    status: 'waiting' | 'approved' | 'rejected' | 'timed_out';
    requestedUnitPrice: number; requestedBy: 'customer' | 'sales';
    approvedUnitPrice: number | null; reason: string | null; decidedAt: Ms | null;
    deadlineAt: Ms; repMayDecide: boolean;       // after the 4-business-hour deadline the rep decides on the same figures
    standingPriceOnly: boolean;                  // claim quote or frozen group: a timeout keeps the standing price
    decidedByRole: 'finance' | 'sales' | null;
  } | null;
  claim: { level: AlertLevel; count: number } | null;   // Sales sees the level only; reasons are Finance-only
  frozen: boolean;                               // buyer group's discounts are frozen
  priceLocked: number | null;                    // the sent price; Sales cannot go below it without Finance (L1)
  sent: { at: Ms; to: string; validUntil: Ms; fromStock: number; fromPo: number; poId: string | null; unitPrice: number; total: number } | null;
  order: { ref: string; acceptedAt: Ms } | null;
  loss: {
    declinedAt: Ms; customerWords: string; reason: LossReason | null; taggedBy: 'decline-reader' | 'sales' | null;
    releasedFromStock: number; releasedFromPo: number; poId: string | null;
  } | null;
  lateAcceptAt: Ms | null;
  firstUnitPrice: number | null;                 // unit price of revision 1, for "less than the first quote"
  blockedReason: 'BELOW_MAX_DISCOUNT' | 'NO_CONTRACT_PRICE' | null;
  needsSalesReason: 'AI_BUDGET' | 'SMALL_ORDER' | 'UNCLEAR' | null;   // 13: why the stage is 'needs_sales'
  actions: SalesActionType[];                    // what Sales may do now; the UI offers nothing else
  technical: {
    model: string | null; policyVersion: string; stockReadAt: Ms | null; holdExpiresAt: Ms | null;
    injection: { phrase: string } | null;
  };
  trace: TraceStep[];
}

export interface CustomerHistory {
  account: Account; months: 12;
  revenue: number; units: number; orders: number;
  avgMarginPct: number; companyMarginPct: number;
  discounts: { count: number; months: string[] };      // ['Mar', 'Aug'], oldest first
  paysInDays: number | null; termsDays: number; overdue: number;
  rows: { date: IsoDate; units: number; unitPrice: number; marginPct: number; note: string; discounted: boolean }[]; // newest first
  lifetimeRevenue: number; lifetimeOrders: number; paidOrders: number; groupPaidOrders: number;
  newCustomer: boolean;                                 // the buyer group has fewer than 3 paid orders (A1: group-wide)
  commitments: Commitment[];
  buyerGroup: BuyerGroupView;
}
export interface Commitment { id: number; itemCode: string; annualQty: number; rep: string; startOn: IsoDate; endsOn: IsoDate; orderedQty: number; shortfall: number; active: boolean; settled: boolean }
export type LinkVia = 'gstin' | 'pan' | 'bank_account' | 'address' | 'email_domain';
export interface BuyerGroupView {
  groupId: string; accounts: string[]; names: string[]; confirmedFakes: number;
  links: { a: string; aName: string; b: string; bName: string; via: LinkVia }[];   // A1: why the accounts are one group
  frozenUntil: Ms | null; frozenReason: string | null;
  probes: { counter: number; requote: number; reopen: number; prompt_leak: number; rfq: number };   // last 7 days
  holds: { open: number; qty: number; valueInr: number; maxOpen: number; maxQty: number; maxValueInr: number; expiries: number; goodStanding: boolean };   // A2
}
/** A3: a condition a discount was granted on. */
export interface DiscountCondition { id: number; kind: 'quantity' | 'order_value' | 'commitment' | 'payment_days'; required: number; grantedInr: number; source: string; commitmentId: number | null; status: 'open' | 'met' | 'broken' }
export interface OrderRow { orderRef: string; account: string; itemCode: string; quantity: number; unitPrice: number; orderedOn: IsoDate; paidDays: number | null; termsDays: number | null; conditions: DiscountCondition[] }
/** A3: a clawback debit note raised when a discount condition broke. */
export interface DebitNote {
  noteRef: string; account: string; accountName: string; orderRef: string | null;
  kind: 'payment_days' | 'volume' | 'reprice'; amountInr: number; commissionInr: number; rep: string | null;
  detail: string; status: 'open' | 'paid'; createdAt: Ms;
}
/** A4: one rep for Finance, last 12 months. */
export interface RepReportRow {
  rep: string; accounts: number; orders: number; revenue: number;
  discountRatePct: number;                     // orders below the contract price
  financeRevisions: number;                    // price revisions the rep sent to Finance
  rfqs: number; phoneSharePct: number;         // RFQs taken by phone
  marginPct: number; peerMarginPct: number | null; marginVsPeersPts: number | null;
  flags: string[];                             // why the reviewer samples this rep; [] when none
}

// ---- Grounding: facts and cited statements (docs/DESIGN.md 7.5) ----
export interface Fact { id: string; key: string; value: string | number | boolean | null; required?: boolean }
export interface CitedStatement { text: string; cites: string[] }

// ---- Buyer claims and fake-rival alerts (docs/DESIGN.md 7.6) ----
export type AlertLevel = 'likely_fake' | 'check' | 'no_concern';
export interface AlertSignal { id: string; weight: 'strong' | 'weak'; text: string; evidence: string; cites: string[] }
export interface ClaimView {
  claimId: string; rfqId: string; groupId: string; account: string;
  rival: string | null; rivalGstin: string | null; claimedPrice: number | null;
  attachmentHash: string | null; attachmentText: string | null; source: string; createdAt: Ms;
  status: 'unverified' | 'genuine' | 'fake';
  alert: {
    alertId: string; level: AlertLevel; signals: AlertSignal[];
    findings: { text: string; quote: string; cites: string[] }[];   // evidence agent, verified; may be []
    thresholdVersion: string;
    review: { verdict: 'correct' | 'wrong'; by: string; at: Ms } | null;
  };
  verification: { result: 'genuine' | 'fake'; channel: string; by: string; at: Ms } | null;
  needsReview: boolean;                       // level is likely_fake or check and no review yet: approve/reject stay off
}
export interface AlertMetrics {
  alerts: number; marked: number; correct: number; precision: number | null;
  confirmedFakes: number; recall: number | null;
  byLevel: Record<string, { marked: number; correct: number; precision: number | null }>;
  bySignal: Record<string, { marked: number; correct: number; precision: number | null }>;
  thresholdsVersion: string;
}
export interface FinanceCase {
  rfqId: string; quoteRef: string; workflowId: string; account: Account; salesRep: string;
  item: { code: string; description: string; clearance: boolean }; quantity: number;
  requestedUnitPrice: number; requestedBy: 'customer' | 'sales'; priceReason: PriceReason | null;
  rules: { contractPrice: number; unitCost: number; minMarginPct: number; minPrice: number; maxDiscountPct: number; floorPrice: number };
  referral: {
    summary: CitedStatement[]; considerations: CitedStatement[];      // each statement cites fact ids in factList
    factList: Fact[];                                                  // the facts the agent saw; X ids are buyer claims
    dataStatus: 'sufficient' | 'insufficient'; missing: string[];      // required facts with no value
    model: string | null; promptVersion: string; fallback: boolean;
  } | null;
  winRate: { atRequested: WinRateView; atContract: WinRateView };
  claims: ClaimView[];                                                 // shown above the facts
  injection: { phrase: string } | null;
  history: CustomerHistory;
  status: 'waiting' | 'approved' | 'rejected' | 'timed_out';
  deadlineAt: Ms; repMayDecide: boolean; standingPriceOnly: boolean;
  salesReason: string | null;                                          // the rep's reason when Sales proposed the price (change or reopen)
  decision: {
    unitPrice: number | null; reason: string | null; factIds: string[]; insufficientData: boolean; by: string | null; byRole: 'finance' | 'sales' | null;
    at: Ms; outcome: 'sent' | 'checking' | 'with_sales'; sentTo: string | null; sentAt: Ms | null;
  } | null;
}
/** Every discount needs a reason citing fact ids from the case (never an X claim id); approving with dataStatus "insufficient" needs a written reason and is flagged. */
export type FinanceDecision = { action: 'approve'; unitPrice: number; reason?: string; factIds?: string[] } | { action: 'reject'; reason?: string };

export interface StockRow {
  itemCode: string; description: string; location: string;
  onHand: number; reserved: number; ordered: number; available: number; low: boolean;
  arriving: { poId: string; quantity: number; on: IsoDate } | null;
  countedAt: Ms; countOld: boolean;
}
export interface StockRequest { rfqId: string; itemCode: string; location: string; onHand: number; accountName: string; quantity: number; askedAt: Ms }
export interface ReservationRow {
  rfqId: string; quoteRef: string; accountName: string; itemCode: string; location: string;
  fromStock: number; fromPo: number; poId: string | null;
  until: Ms | null;            // hold or validity end, for stock-only rows
  deliverOn: IsoDate[];        // delivery dates, for rows with a PO part
  status: 'held' | 'ordered' | 'released';
}

export type MessageKind = 'rfq' | 'reply' | 'ack' | 'question' | 'quote' | 'order_confirmed' | 'quote_expired' | 'lost_ack' | 'price_refused' | 'counter_reply';
export interface CustomerMessage {
  id: string; rfqId: string | null; at: Ms; direction: 'in' | 'out'; kind: MessageKind;
  mail: { from: string; subject: string; paragraphs: string[]; rows: { label: string; value: string; strong?: boolean }[] } | null;
  chat: string | null;
  canReply: boolean;                              // show the reply box under this mail
  reply: { text: string; at: Ms } | null;         // the customer's reply to this message
}

export interface AuditRow {
  id: number; at: Ms; actor: string; event: string; version: string | null; result: string | null;
  tone: 'ok' | 'wait' | 'bad' | null;
  raw: { event: string; actor: string; model: string | null; promptVersion: string | null; detail: unknown };
}
export interface AgentInfo {
  id: 'intake' | 'clarify' | 'finance' | 'decline' | 'evidence';
  name: string; job: string; actor: string; promptVersion: string; file: string;
  model: string | null; temperature: number;
  tools: { name: string; description: string }[];
  sees: string; returns: string; onFailure: string;
  cites: string; abstains: string;                  // what the output must cite; the defined output when data is missing
  systemPrompt: string; userTemplate: string; outputSchema: unknown;   // JSON Schema
}
export interface Settings { now: Ms; staleStock: boolean; testRequests: { id: string; label: string }[] }

// ---- 13. AI usage and cost (added; not in the original 8.2) ----

/** Money spent on one RFQ so far. Rupees with paise (two decimals); tokens are whole numbers. */
export interface UsageView {
  calls: number;                                   // agent calls that reached a model
  tokens: { input: number; output: number; reasoning: number; total: number };
  capTokens: number;                               // 40,000 per RFQ
  inrPerMTokens: number;                           // rate of the model in force for this RFQ (₹ per million tokens)
  budgetInr: number;                               // the cap in rupees: capTokens x inrPerMTokens / 1,000,000
  budgetUsedPct: number;                           // share of the cap used (tokens), 0 to 100, four decimals
  capped: boolean;                                 // the cap was reached: no more agent steps
  smallOrder: boolean;                             // under Rs 10,000: cheap path
  aiInr: number;                                   // model cost from the per-model price table
  actions: number;                                 // Temporal actions (workflow start, activities, signals, timers)
  computeInr: number;                              // actions / actionsPerRfq x computeInrPerRfq
  totalInr: number;                                // aiInr + computeInr
  grossMarginInr: number | null;                   // profit on the quote at the current price
  pctOfMargin: number | null;                      // totalInr as % of grossMarginInr, four decimals (0.0006 = 0.0006%)
}
export interface AiCallRow {
  at: Ms; agent: 'intake' | 'clarify' | 'finance' | 'decline' | 'evidence';
  model: string; promptVersion: string;
  inputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number;
  inrPerMTokens: number; inr: number;
  ok: boolean;                                     // false: the output failed its checks or the call threw
}
export interface UsageDetail { rfqId: string; quoteRef: string; accountName: string; usage: UsageView; calls: AiCallRow[] }
export interface UsageReport {
  now: Ms; stage: 'dev' | 'prerelease' | 'prod';
  prices: { model: string; inrPerMTokens: number }[];
  computeInrPerRfq: number; actionsPerRfq: number; capTokens: number; smallOrderBelowInr: number;
  totals: { quotes: number; tokens: number; aiInr: number; computeInr: number; totalInr: number; grossMarginInr: number; pctOfMargin: number | null };
  quotes: { rfqId: string; quoteRef: string; accountName: string; stage: Stage; usage: UsageView }[];
}
