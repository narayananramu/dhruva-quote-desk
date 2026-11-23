import type { AlertLevel } from './claims';
import type { Channel, DeliveryOffer, DeliveryOption, LossReason, TraceStep } from './contract';
import type { FinanceApproval, FinanceFacts, ItemRules, PriceFacts, RfqRequest } from './domain';
import type { Claim, Fact } from './agents/grounding';
import type { PriceReason } from './agents/prompts';

/**
 * The workflow's state: returned by the `state` query and published to `rfqs.state_json` at every
 * step. The API derives every view from it (src/views.ts). Plain JSON only.
 */

export type Status =
  | 'intake'
  | 'checking'
  | 'needs_customer'
  | 'awaiting_finance'
  | 'finance_rejected'
  | 'blocked'
  | 'awaiting_sales'
  | 'awaiting_inventory'
  | 'sending'
  | 'sent'
  | 'expired'
  | 'ordered'
  | 'lost'
  | 'closed'
  | 'failed';

/** `manual`: section 13, the AI budget is used up or a small order needs a person. */
export type SalesNeed = 'review' | 'stale' | 'short' | 'hold_expired' | 'manual';

export interface QuoteInput {
  rfqId: string;
  quoteRef: string;
  account: string;
  channel: Channel;
  receivedAt: number;
  clockOffsetMs: number;
  workflowId?: string;
  text?: string; // free text → intake agent
  subject?: string; // mail subject, prefixed to the text for the intake agent
  request?: unknown; // structured → parseStructured, no agent
  caller?: string; // phone only; never sent to a model
  createdBy?: string; // phone only: the sales rep
  messageId?: string; // the inbound message that started the RFQ
  /** A rival claim sent with a structured request (v1 API `rival_claim`). */
  claim?: { rival: string | null; rivalGstin: string | null; claimedPrice: number | null; attachmentText: string | null };
  seed?: {
    skipAck?: boolean;
    requestText?: string;
    referral?: boolean; // the recorded case is the code-written case (no model call)
    trace?: TraceStep[];
  };
}

export interface FinanceState {
  status: 'waiting' | 'approved' | 'rejected' | 'timed_out';
  requestedUnitPrice: number;
  requestedBy: 'customer' | 'sales';
  priceReason: PriceReason | null;
  approvedUnitPrice: number | null;
  reason: string | null;
  askedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  decidedByRole: 'finance' | 'sales' | null;
  factIds: string[];
  insufficientData: boolean; // approved while the case had missing required facts: flagged on the audit row
  outcome: 'sent' | 'checking' | 'with_sales' | null;
  deadlineAt: number; // 4 business hours after askedAt
  repMayDecide: boolean; // the deadline passed: the rep decides on the same figures
  standingPriceOnly: boolean; // claim quote or frozen group: a timeout keeps the standing price
  salesReason: string | null; // the rep's reason when Sales proposed the price (a change or a reopen)
  referral: {
    facts: FinanceFacts;
    factList: Fact[];
    dataStatus: 'sufficient' | 'insufficient';
    missing: string[];
    summary: Claim[];
    considerations: Claim[];
    model: string | null;
    promptVersion: string;
    fallback: boolean;
  } | null;
}

export interface UsageState {
  calls: number;
  input: number;
  output: number;
  reasoning: number;
  aiInr: number;
  capped: boolean;
  smallOrder: boolean;
}

export interface QuoteState {
  rfqId: string;
  quoteRef: string;
  workflowId: string;
  account: string;
  channel: Channel;
  receivedAt: number;
  caller: string | null;
  createdBy: string | null;
  status: Status;
  salesNeed: SalesNeed | null;
  closedReason: 'NO_CUSTOMER_REPLY' | 'NO_FINANCE_DECISION' | 'NO_SALES_DECISION' | null;
  final: boolean;
  draftVersion: number;
  revision: number;
  requestText: string | null;
  request: RfqRequest | null;
  clarifications: { question: string; reply: string }[];
  item: ItemRules | null;
  quantity: number | null;
  price: PriceFacts | null;
  salesPrice: number | null;
  approval: FinanceApproval | null;
  finance: FinanceState | null;
  hold: { quantity: number; expiresAt: number; live: boolean } | null;
  delivery: DeliveryOption | null;
  deliveryOffer: DeliveryOffer | null;
  deliveryOptions: DeliveryOption[];
  chosenDelivery: 'stock' | 'split' | 'full' | null; // from a reopen
  question: { text: string; by: 'agent' | 'sales'; at: number } | null;
  questionMessageId: string | null;
  /** `answered`: code already replied (a counter, or a reply after expiry); Sales only reads it. */
  customerReply: { text: string; at: number; answered?: boolean } | null;
  sent: {
    at: number;
    to: string;
    validUntil: number;
    fromStock: number;
    fromPo: number;
    poId: string | null;
    unitPrice: number;
    total: number;
    revision: number;
    messageId: string;
  } | null;
  order: { ref: string; acceptedAt: number } | null;
  loss: {
    declinedAt: number;
    customerWords: string;
    reason: LossReason | null;
    taggedBy: 'decline-reader' | 'sales' | null;
    releasedFromStock: number;
    releasedFromPo: number;
    poId: string | null;
    poArrivesOn: string | null;
  } | null;
  lateAcceptAt: number | null;
  firstUnitPrice: number | null;
  blockedReason: 'BELOW_MAX_DISCOUNT' | 'NO_CONTRACT_PRICE' | null;
  needsSalesReason: 'AI_BUDGET' | 'SMALL_ORDER' | 'UNCLEAR' | null;
  autoSend: boolean;
  reopened: boolean;
  acked: boolean;
  injection: { phrase: string } | null;
  /** Buyer claims on this RFQ (internal; Sales sees the level only). */
  claim: { count: number; level: AlertLevel; ids: string[] } | null;
  /** The last sent unit price. Sales cannot go below it without Finance (L1). */
  priceLocked: number | null;
  /** Counters answered with the uniform reply on this RFQ. A buyer who never counters keeps stock priority (H1). */
  counters: number;
  /** H1: the payment days the buyer offered (faster payment is a trade), else null. */
  paymentDays?: number | null;
  /** A2: the buyer group is at its hold limit or not in good standing: no stock held, the quote goes out indicative. */
  holdLimited?: 'HOLD_LIMIT' | 'NOT_IN_GOOD_STANDING' | null;
  /** A2: when the buyer accepted an indicative quote; cleared when the firm quote goes out. */
  acceptedIndicativeAt?: number | null;
  stockReadAt: number | null;
  model: string | null;
  usage: UsageState;
  compute: { activities: number; signals: number; timers: number };
  trace: TraceStep[];
  updatedAt: number;
}

/** Temporal actions so far: the start, every activity, signal and timer. */
export const actionsOf = (s: Pick<QuoteState, 'compute'>) => 1 + s.compute.activities + s.compute.signals + s.compute.timers;

export const FINAL: Status[] = ['ordered', 'closed', 'failed'];
