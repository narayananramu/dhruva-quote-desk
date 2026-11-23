/**
 * Fact lists and the citation verifier (docs/DESIGN.md 7.5).
 *
 * Code builds a fact list for every agent call, the model cites fact ids, and the functions here
 * check each cite after the call. Pure functions: no I/O, no clock, no network, no model calls,
 * no Node imports (the workflow bundle may import this file).
 *
 * Every verify* function returns a Verdict. `ok: false` carries the failed checks and a one-line
 * `reason` for the audit row (`meta.problem`). What the caller does with it:
 *   intake         groundIntake() sets each failed field to null (a later step asks the customer)
 *   clarification  send templateQuestion()
 *   finance        store templateFinanceCase(facts)
 *   decline        groundDecline() turns the decision into "question" (Sales reads the reply)
 *   evidence       groundEvidence() drops every finding that fails
 *
 * promptLeak() runs on every model output: a canary, eight consecutive words of any system prompt,
 * or (in customer-facing text) a schema or tool name is a leak.
 */
import {
  AGENT_PROMPTS,
  BANNED_WORDS,
  CANARIES,
  COURTESY_WORDS,
  HEDGE_WORDS,
  LOSS_REASONS,
  OPINION_WORDS,
  PROMPT_LIMITS,
  type LossReason,
  type PriceReason,
  type ReplyDecision,
  VERDICT_WORDS,
} from './prompts';

// ---- Facts ----

export type FactValue = string | number | boolean | null;

/** One line of the model's input. `id` is stable: the same id always means the same key for an agent. */
export interface Fact {
  id: string; // "F3", "R2", "H1"
  key: string; // "price.requested", "reply.segment"
  value: FactValue; // null means unknown
  required?: boolean; // finance only: Finance needs this fact for the decision
}

export const FACT_ID = /^[A-Z]\d{1,3}$/;

/** The one user message every agent receives. */
export const factsMessage = (facts: Fact[]): { facts: Fact[] } => ({ facts });

/** Keys that hold text a customer wrote. */
export const isCustomerFact = (f: Fact) => f.key.startsWith('request.') || f.key.startsWith('reply.') || f.key.startsWith('attachment.');

/** A buyer's claim (X facts). Shown to Finance as unverified; no statement or Finance reason may cite one. */
export const isClaimFact = (f: Fact | string) => (typeof f === 'string' ? f : f.id).startsWith('X');

/**
 * Splits customer text into sentences so that a cite points at one sentence, not at the whole
 * message. Splits on line breaks and on sentence ends followed by a capital letter, so
 * "Rs. 900" stays in one piece. Each segment is an exact piece of the text.
 */
export function segmentText(text: string, max: number = PROMPT_LIMITS.textSegments): string[] {
  const parts = text
    .split(/(?<=[.?!])\s+(?=[A-Z"'(\[])|\s*\n+\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= max) return parts;
  return [...parts.slice(0, max - 1), parts.slice(max - 1).join(' ')];
}

const segments = (prefix: string, key: string, text: string, startAt = 1): Fact[] => segmentText(text).map((value, i) => ({ id: `${prefix}${startAt + i}`, key, value }));

// ---- Fact builders (one per agent) ----

export interface IntakeInput {
  today: string;
  request: string;
  clarifications: { question: string; reply: string }[];
}

/** T1 today, R* request sentences, Q* our questions, A* reply sentences. C* facts are added by the tool. */
export function intakeFacts(input: IntakeInput): Fact[] {
  const facts: Fact[] = [{ id: 'T1', key: 'today', value: input.today }, ...segments('R', 'request.segment', input.request)];
  let a = 1;
  input.clarifications.slice(-PROMPT_LIMITS.clarificationTurns).forEach((c, i) => {
    facts.push({ id: `Q${i + 1}`, key: `question.${i + 1}`, value: c.question });
    const replies = segments('A', `reply.${i + 1}.segment`, c.reply, a);
    a += replies.length;
    facts.push(...replies);
  });
  return facts;
}

/** A catalogue row as a fact. `n` counts rows across all lookups of one intake call, starting at 1. */
export const catalogueFact = (n: number, part: { partNumber: string; description: string }): Fact => ({ id: `C${n}`, key: 'catalogue.part', value: `${part.partNumber} | ${part.description}` });

export interface ClarificationInput {
  reason: 'part' | 'account' | 'quantity';
  ownAccountName: string;
  options: { partNumber: string; description: string }[];
  quantity: number | null;
}

export function clarifyFacts(input: ClarificationInput): Fact[] {
  return [
    { id: 'F1', key: 'reason', value: input.reason },
    { id: 'F2', key: 'account.own', value: input.ownAccountName },
    { id: 'F3', key: 'quantity', value: input.quantity },
    ...input.options.map((o, i) => catalogueFact(i + 1, o)),
  ];
}

export interface DeclineInput {
  quote: { itemCode: string; quantity: number; delivery: string };
  reply: string;
}

export function declineFacts(input: DeclineInput): Fact[] {
  return [
    { id: 'F1', key: 'quote.itemCode', value: input.quote.itemCode },
    { id: 'F2', key: 'quote.quantity', value: input.quote.quantity },
    { id: 'F3', key: 'quote.delivery', value: input.quote.delivery },
    ...segments('R', 'reply.segment', input.reply),
  ];
}

/**
 * Everything the finance referral agent may use, computed by code (domain.ts and store.ts).
 * null means "not on record"; never pass 0 for unknown. Every figure is a whole number (rupees,
 * whole percent) except the margins, which have one decimal, so a statement can quote it exactly.
 */
export interface FinanceCase {
  accountName: string;
  itemCode: string;
  quantity: number;
  requestedBy: 'customer' | 'sales';
  priceReason: PriceReason | null;
  requestedUnitPrice: number;
  contractPrice: number;
  unitCost: number;
  minMarginPct: number;
  minPrice: number;
  maxDiscountPct: number;
  floorPrice: number;
  marginAtRequestedPct: number;
  marginAtContractPct: number;
  totalAtRequested: number;
  totalAtContract: number;
  profitAtRequested: number;
  profitAtContract: number;
  // Past quotes for the part group (win rate by price). null below the minimum sample.
  quotesAtRequested: number | null;
  wonAtRequested: number | null;
  winRateAtRequestedPct: number | null;
  winRateAtContractPct: number | null;
  expectedProfitAtRequested: number | null; // profitAtRequested x win rate at the requested price
  expectedProfitAtContract: number | null; // profitAtContract x win rate at the contract price
  winRateAtRequestedLowPct: number | null; // 90% Wilson interval
  winRateAtRequestedHighPct: number | null;
  winRateAtContractLowPct: number | null;
  winRateAtContractHighPct: number | null;
  expectedProfitAtRequestedLow: number | null;
  expectedProfitAtRequestedHigh: number | null;
  expectedProfitAtContractLow: number | null;
  expectedProfitAtContractHigh: number | null;
  quotesAtContract: number | null;
  // This customer's history
  orders: number;
  lifetimeRevenue: number;
  avgPaymentDays: number | null;
  termsDays: number | null;
  overdueInvoices: number;
  discountedOrders: number;
  // New-customer rule, evaluated by code
  newCustomer: boolean;
  orderValue: number;
  newCustomerOrderThreshold: number; // 1000000
  yearVolumeCommitted: boolean;
  newCustomerDiscountAllowed: boolean;
}

/** id, key, field, required. Order is fixed so ids are stable across calls, tests and the UI. */
const FINANCE_FACTS: readonly (readonly [string, string, keyof FinanceCase, boolean])[] = [
  ['F1', 'account.name', 'accountName', false],
  ['F2', 'item.code', 'itemCode', false],
  ['F3', 'quote.quantity', 'quantity', false],
  ['F4', 'request.by', 'requestedBy', false],
  ['F5', 'request.reason', 'priceReason', false],
  ['F6', 'price.requested', 'requestedUnitPrice', true],
  ['F7', 'price.contract', 'contractPrice', false],
  ['F8', 'cost.unit', 'unitCost', false],
  ['F9', 'margin.minimumPct', 'minMarginPct', true],
  ['F10', 'price.minimum', 'minPrice', false],
  ['F11', 'discount.maxPct', 'maxDiscountPct', false],
  ['F12', 'price.maxDiscount', 'floorPrice', false],
  ['F13', 'margin.atRequestedPct', 'marginAtRequestedPct', true],
  ['F14', 'margin.atContractPct', 'marginAtContractPct', false],
  ['F15', 'total.atRequested', 'totalAtRequested', false],
  ['F16', 'total.atContract', 'totalAtContract', false],
  ['F17', 'profit.atRequested', 'profitAtRequested', false],
  ['F18', 'profit.atContract', 'profitAtContract', false],
  ['W1', 'pastQuotes.atRequested.count', 'quotesAtRequested', false],
  ['W2', 'pastQuotes.atRequested.won', 'wonAtRequested', false],
  ['W3', 'winRate.atRequestedPct', 'winRateAtRequestedPct', false],
  ['W4', 'winRate.atContractPct', 'winRateAtContractPct', false],
  ['W5', 'expectedProfit.atRequested', 'expectedProfitAtRequested', true],
  ['W6', 'expectedProfit.atContract', 'expectedProfitAtContract', true],
  ['W7', 'winRate.atRequested.lowPct', 'winRateAtRequestedLowPct', false],
  ['W8', 'winRate.atRequested.highPct', 'winRateAtRequestedHighPct', false],
  ['W9', 'winRate.atContract.lowPct', 'winRateAtContractLowPct', false],
  ['W10', 'winRate.atContract.highPct', 'winRateAtContractHighPct', false],
  ['W11', 'expectedProfit.atRequested.low', 'expectedProfitAtRequestedLow', false],
  ['W12', 'expectedProfit.atRequested.high', 'expectedProfitAtRequestedHigh', false],
  ['W13', 'expectedProfit.atContract.low', 'expectedProfitAtContractLow', false],
  ['W14', 'expectedProfit.atContract.high', 'expectedProfitAtContractHigh', false],
  ['W15', 'pastQuotes.atContract.count', 'quotesAtContract', false],
  ['H1', 'history.orders', 'orders', false],
  ['H2', 'history.lifetimeRevenue', 'lifetimeRevenue', true],
  ['H3', 'history.avgPaymentDays', 'avgPaymentDays', true],
  ['H4', 'history.termsDays', 'termsDays', false],
  ['H5', 'history.overdueInvoices', 'overdueInvoices', false],
  ['H6', 'history.discountedOrders', 'discountedOrders', false],
  ['P1', 'policy.newCustomer', 'newCustomer', false],
  ['P2', 'policy.orderValue', 'orderValue', false],
  ['P3', 'policy.newCustomerOrderThreshold', 'newCustomerOrderThreshold', false],
  ['P4', 'policy.yearVolumeCommitted', 'yearVolumeCommitted', false],
  ['P5', 'policy.newCustomerDiscountAllowed', 'newCustomerDiscountAllowed', true],
];

/** A buyer's claim as Finance sees it: unverified unless a person recorded "genuine". */
export interface ClaimFactInput {
  rival: string | null;
  rivalPrice: number | null;
  status: 'unverified' | 'genuine' | 'fake';
}

/**
 * The finance referral's fact list. Claims are appended as X facts: the model sees them marked as
 * claims, and verifyFinance rejects any statement that cites one.
 */
export function financeFactList(c: FinanceCase, claims: ClaimFactInput[] = []): Fact[] {
  const facts: Fact[] = FINANCE_FACTS.map(([id, key, field, required]) => ({ id, key, value: c[field], ...(required && { required: true }) }));
  let x = 0;
  for (const cl of claims) {
    facts.push({ id: `X${++x}`, key: 'claim.rivalPrice', value: cl.rivalPrice });
    facts.push({ id: `X${++x}`, key: 'claim.rival', value: cl.rival });
    facts.push({ id: `X${++x}`, key: 'claim.status', value: cl.status });
  }
  return facts;
}

// ---- Verdict ----

export type FailureCode =
  | 'UNKNOWN_CITE' // cites an id that is not in the input
  | 'NO_CITE' // a decision or statement with no cite
  | 'WRONG_CITE_KIND' // e.g. an accept that cites the quote instead of the reply
  | 'UNSUPPORTED_VALUE' // the value is not in the cited fact
  | 'UNGROUNDED_NUMBER'
  | 'UNGROUNDED_DATE'
  | 'UNGROUNDED_PART'
  | 'UNGROUNDED_NAME'
  | 'EVIDENCE_NOT_IN_FACT'
  | 'ID_IN_TEXT'
  | 'ABSTAINED' // the model returned its "insufficient data" output
  | 'DATA_STATUS_MISMATCH' // missing / dataStatus disagree with the null required facts
  | 'MISSING_REQUIRED_CITE' // a required fact that has a value is cited nowhere
  | 'BAD_SHAPE'
  | 'RECOMMENDS'
  | 'CITES_CLAIM' // a statement or Finance reason cites a buyer claim (X fact)
  | 'PROMPT_LEAK' // a canary, 8+ consecutive prompt words, or a schema or tool name in customer text
  | 'VERDICT' // an agent judged a rival document (genuine, fake, verified)
  | 'SLOP'; // writing lint; detail names the rule and the word

export interface Failure {
  code: FailureCode;
  field: string; // "quantity", "summary[1]", "decision"
  detail: string;
}

export interface Verdict {
  ok: boolean;
  failures: Failure[];
  reason: string | null; // first failure as "CODE field: detail", for meta.problem
}

function verdict(failures: Failure[]): Verdict {
  const first = failures[0];
  return { ok: failures.length === 0, failures, reason: first ? `${first.code} ${first.field}: ${first.detail}`.slice(0, 200) : null };
}

// ---- Shared checks ----

const PART_NUMBER = /\b[A-Z]{2,5}-\d{2,3}(?:-[A-Z]{2})?\b/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const ID_TOKEN = /\b[A-Z]\d{1,3}\b/g;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

const toNumber = (raw: string) => Number(raw.replace(/,/g, ''));

/** Figures in a text. Part numbers and ISO dates are names, not figures, and are checked separately. */
export function numbersIn(text: string): number[] {
  return (text.replace(PART_NUMBER, ' ').replace(ISO_DATE, ' ').match(NUMBER) ?? []).map(toNumber);
}

type FactIndex = Map<string, Fact>;
const index = (facts: Fact[]): FactIndex => new Map(facts.map((f) => [f.id, f]));

/** Checks ids exist and that there are enough. Returns the cited facts that do exist. */
function resolveCites(cites: string[], byId: FactIndex, field: string, min: number, failures: Failure[]): Fact[] {
  const found: Fact[] = [];
  for (const id of cites) {
    const f = byId.get(id);
    if (f) found.push(f);
    else failures.push({ code: 'UNKNOWN_CITE', field, detail: `${id} is not an input fact` });
  }
  if (cites.length > PROMPT_LIMITS.citesPerItem) failures.push({ code: 'BAD_SHAPE', field, detail: `more than ${PROMPT_LIMITS.citesPerItem} cites` });
  if (cites.length < min) failures.push({ code: 'NO_CITE', field, detail: `needs at least ${min} cite${min > 1 ? 's' : ''} to an input fact` });
  return found;
}

const stringValues = (cited: Fact[]) => cited.map((f) => (typeof f.value === 'string' ? f.value : '')).filter(Boolean);

/** Numbers a text may contain: the cited numeric values and the figures inside cited strings. */
function allowedNumbers(cited: Fact[]): Set<number> {
  const allowed = new Set<number>();
  for (const f of cited) {
    if (typeof f.value === 'number') allowed.add(Math.abs(f.value));
    else if (typeof f.value === 'string') for (const n of numbersIn(f.value)) allowed.add(n);
  }
  return allowed;
}

/** Capitalised words that are not names. Anything else capitalised mid-sentence must be in a cited fact. */
const NOT_NAMES = new Set(
  'finance sales inventory operations inr contract rfq january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday'.split(
    ' ',
  ),
);

/**
 * Every number, ISO date, part number and capitalised name in `text` must come from a cited fact.
 * A name at the start of a sentence is not checked (see README, "Limits of the verifier").
 */
export function groundedText(text: string, cited: Fact[], field: string): Failure[] {
  const failures: Failure[] = [];
  const strings = stringValues(cited);
  const haystack = strings.join('\n').toLowerCase();

  for (const id of text.match(ID_TOKEN) ?? []) if (!haystack.includes(id.toLowerCase())) failures.push({ code: 'ID_IN_TEXT', field, detail: `fact id ${id} written in text` });
  const noIds = text.replace(ID_TOKEN, (m) => (haystack.includes(m.toLowerCase()) ? m : ' '));

  const allowed = allowedNumbers(cited);
  for (const n of numbersIn(noIds)) if (!allowed.has(n)) failures.push({ code: 'UNGROUNDED_NUMBER', field, detail: `${n} is not a value of a cited fact` });
  for (const d of noIds.match(ISO_DATE) ?? []) if (!strings.some((s) => s.includes(d))) failures.push({ code: 'UNGROUNDED_DATE', field, detail: `${d} is not in a cited fact` });
  for (const pn of noIds.match(PART_NUMBER) ?? []) if (!strings.some((s) => s.includes(pn))) failures.push({ code: 'UNGROUNDED_PART', field, detail: `${pn} is not in a cited fact` });

  const plain = noIds.replace(PART_NUMBER, ' ');
  for (const m of plain.matchAll(/\b[A-Z][A-Za-z]{2,}\b/g)) {
    const before = plain.slice(0, m.index).trimEnd();
    if (before === '' || /[.?!:]$/.test(before)) continue; // sentence start
    const word = m[0].toLowerCase();
    if (NOT_NAMES.has(word) || haystack.includes(word)) continue;
    failures.push({ code: 'UNGROUNDED_NAME', field, detail: `"${m[0]}" is not in a cited fact` });
  }
  return failures;
}

// ---- Writing lint (anti-slop) ----

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches each word with its common endings: ensure, ensures, ensured, ensuring. */
function wordRegex(words: readonly string[]): RegExp {
  const alts = words.map((w) => (w.endsWith('e') ? `${escapeRe(w.slice(0, -1))}(?:e|es|ed|ing|ely)` : `${escapeRe(w)}(?:s|es|ed|ing|ly)?`));
  return new RegExp(`(?<![\\w-])(?:${alts.join('|')})(?![\\w-])`, 'i');
}

const BANNED_RE = wordRegex(BANNED_WORDS);
const HEDGE_RE = wordRegex(HEDGE_WORDS);
const COURTESY_RE = wordRegex(COURTESY_WORDS);
const OPINION_RE = wordRegex(OPINION_WORDS);
const APPROX_RE = /(?:\b(?:about|around|roughly|approximately|approx|nearly|almost|circa|some)\b|~)\s*(?:₹|rs\.?\s*|inr\s*)?\d/i;
const NUMBER_WORD_RE = /\d\s*(?:k|cr|mn|lakhs?|crores?|thousand|million)\b|\b(?:half|double|twice|triple|dozen|hundred|thousand|lakhs?|crores?|million)\b/i;
const RECOMMEND_RE = /\b(?:recommend\w*|suggest\w*|advis\w*|should|must|ought|worth|justif\w*|warrant\w*|i (?:approve|reject)|approve|approves|approving|acceptable|can accept|can agree|keeps? the (?:account|customer|business))\b/i;
/** Spelled-out figures: a figure is written in digits so the verifier can check it against a fact. */
const SPELLED_NUMBER_RE = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|percent|per cent)\b/i;
/** Predictions: the case states what the records show, never what will happen. */
const PREDICT_RE = /\b(?:will|would|going to|next (?:year|month|quarter|order)|in future|expects? to|plans? to)\b/i;
/** Judgements about the customer that no fact states. */
const JUDGE_RE = /\b(?:(?<!how )many|several|few|late|slow|poor|good|bad|risky|safe|valuable|important|key|high|low)\b/i;
/** A rival or the buyer's claim: Finance sees claims in their own panel, never inside the case. */
const RIVAL_RE = /\b(?:rivals?|competitors?|competition|competing|another (?:supplier|vendor))\b/i;
const FILLER_RE = /\b(?:please note|it is important to|it should be noted|it is worth noting|in order to|as an ai|in conclusion|in summary|i hope|feel free|do not hesitate|rest assured|at the end of the day|when it comes to)\b/i;

export type Audience = 'customer' | 'finance';

/** Lint for text a person reads. Each failure has code SLOP (or RECOMMENDS) and names the rule. */
export function lintSlop(text: string, field: string, audience: Audience): Failure[] {
  const out: Failure[] = [];
  const slop = (rule: string, hit: string) => out.push({ code: 'SLOP', field, detail: `${rule}: "${hit}"` });
  const hit = (re: RegExp, rule: string) => {
    const m = text.match(re);
    if (m) slop(rule, m[0]);
  };
  hit(/[—–]|\s--\s/, 'DASH');
  hit(/!/, 'EXCLAMATION');
  hit(/[*#`]|^\s*[-•]\s|\n/m, 'FORMATTING');
  hit(BANNED_RE, 'BANNED_WORD');
  hit(HEDGE_RE, 'HEDGE');
  hit(COURTESY_RE, 'COURTESY');
  hit(FILLER_RE, 'FILLER');
  hit(APPROX_RE, 'APPROXIMATION');
  hit(NUMBER_WORD_RE, 'NUMBER_WORD');
  if (audience === 'finance') {
    hit(OPINION_RE, 'OPINION');
    hit(SPELLED_NUMBER_RE, 'NUMBER_WORD');
    hit(JUDGE_RE, 'JUDGEMENT');
    const m = text.match(RECOMMEND_RE) ?? text.match(PREDICT_RE);
    if (m) out.push({ code: 'RECOMMENDS', field, detail: `"${m[0]}"` });
  }
  for (const sentence of text.split(/(?<=[.?!])\s+/)) {
    const words = sentence.split(/\s+/).filter(Boolean).length;
    if (words > PROMPT_LIMITS.sentenceWords) slop('LONG_SENTENCE', `${words} words`);
  }
  return out;
}

// ---- Prompt leak (P1) ----

const words = (t: string) => t.toLowerCase().match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) ?? [];

/** Every run of PROMPT_LIMITS.promptOverlapWords consecutive words of every system prompt. */
const PROMPT_SHINGLES: Set<string> = (() => {
  const n = PROMPT_LIMITS.promptOverlapWords;
  const set = new Set<string>();
  for (const p of Object.values(AGENT_PROMPTS)) {
    const w = words(p.system);
    for (let i = 0; i + n <= w.length; i++) set.add(w.slice(i, i + n).join(' '));
  }
  return set;
})();

/**
 * Schema field and tool names. Customer-facing text never needs them; seeing one means the model is
 * describing its own interface.
 */
export const SCHEMA_WORDS = [
  'lookupCatalogue', 'partNumber', 'partDescription', 'requestedUnitPrice', 'priceReason', 'deliverBy', 'deliverTo',
  'dataStatus', 'considerations', 'cites', 'catalogue.part', 'account.own', 'request.segment', 'reply.segment',
  'attachment.segment', 'system prompt', 'json schema', 'canary',
] as const;
const SCHEMA_RE = new RegExp(`(?:${SCHEMA_WORDS.map(escapeRe).join('|')})`, 'i');

/**
 * Null when `text` is safe, else what leaked. `customerFacing` adds the schema and tool names check.
 * Runs on every model output before it is used.
 */
export function promptLeak(text: string, customerFacing: boolean): string | null {
  const lower = text.toLowerCase();
  for (const c of Object.values(CANARIES)) if (lower.includes(c)) return `canary ${c}`;
  const w = words(text);
  const n = PROMPT_LIMITS.promptOverlapWords;
  for (let i = 0; i + n <= w.length; i++) {
    const run = w.slice(i, i + n).join(' ');
    if (PROMPT_SHINGLES.has(run)) return `prompt words "${run}"`;
  }
  if (customerFacing) {
    const m = text.match(SCHEMA_RE);
    if (m) return `schema word "${m[0]}"`;
  }
  return null;
}

const leakFailure = (text: string, field: string, customerFacing: boolean): Failure[] => {
  const hit = promptLeak(text, customerFacing);
  return hit ? [{ code: 'PROMPT_LEAK', field, detail: hit }] : [];
};

// ---- 1. Intake ----

export interface Cited<T> {
  value: T;
  cites: string[];
}

export interface IntakeCited {
  account: Cited<string | null>;
  partNumber: Cited<string | null>;
  partDescription: Cited<string | null>;
  quantity: Cited<number | null>;
  firm: Cited<boolean>;
  requestedUnitPrice: Cited<number | null>;
  priceReason: Cited<PriceReason | null>;
  deliverBy: Cited<string | null>;
  deliverTo: Cited<string | null>;
}

/** The flat shape the rest of the workflow already uses (rfqRequestSchema). */
export type IntakeFields = { [K in keyof IntakeCited]: IntakeCited[K]['value'] };

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const digitsIn = (s: string) => (s.match(/\d+/g) ?? []).map(Number);

/** Does the sentence give this day and month (and this year, if it gives a year at all)? */
function statesDate(sentence: string, iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const nums = digitsIn(sentence);
  const name = MONTHS[m - 1] ?? '';
  const monthNamed = name !== '' && new RegExp(`\\b(?:${name}|${name.slice(0, 3)}|${name.slice(0, 4)})\\b`, 'i').test(sentence);
  if (!nums.includes(d) || !(monthNamed || nums.includes(m))) return false;
  const years = nums.filter((n) => n >= 1000 && n <= 9999);
  return years.length === 0 || years.includes(y);
}

const STRING_FIELDS = ['account', 'partDescription', 'deliverTo'] as const;
const NUMBER_FIELDS = ['quantity', 'requestedUnitPrice'] as const;

/**
 * `facts` is the fact list sent to the model plus every C fact the catalogue tool returned.
 * One failure per unsupported field; groundIntake() turns each into a null.
 */
export function verifyIntake(out: IntakeCited, facts: Fact[]): Verdict {
  const byId = index(facts);
  const failures: Failure[] = [];

  const customerCites = (field: keyof IntakeCited): Fact[] | null => {
    const before = failures.length;
    const cited = resolveCites(out[field].cites, byId, field, 1, failures);
    const customer = cited.filter(isCustomerFact);
    if (failures.length === before && customer.length === 0) failures.push({ code: 'WRONG_CITE_KIND', field, detail: 'must cite a request or reply sentence' });
    return failures.length === before ? customer : null;
  };
  const unsupported = (field: string, detail: string) => failures.push({ code: 'UNSUPPORTED_VALUE', field, detail });

  for (const field of STRING_FIELDS) {
    const value = out[field].value;
    if (value === null) continue;
    const customer = customerCites(field);
    if (customer && !customer.some((f) => String(f.value).includes(value.trim()))) unsupported(field, `"${value}" is not in a cited sentence`);
  }
  for (const field of NUMBER_FIELDS) {
    const value = out[field].value;
    if (value === null) continue;
    const customer = customerCites(field);
    if (customer && !customer.some((f) => numbersIn(String(f.value)).includes(value))) unsupported(field, `${value} is not in a cited sentence`);
  }
  if (out.partNumber.value !== null) {
    const pn = out.partNumber.value;
    const customer = customerCites('partNumber');
    if (customer) {
      const rows = out.partNumber.cites.map((id) => byId.get(id)).filter((f): f is Fact => f?.key === 'catalogue.part');
      if (!rows.some((f) => String(f.value).split(' | ')[0] === pn)) unsupported('partNumber', `${pn} is not a cited catalogue row`);
    }
  }
  if (out.deliverBy.value !== null) {
    const iso = out.deliverBy.value;
    const customer = customerCites('deliverBy');
    if (customer && !customer.some((f) => statesDate(String(f.value), iso))) unsupported('deliverBy', `the day and month of ${iso} are not in a cited sentence`);
  }
  if (out.priceReason.value !== null) customerCites('priceReason');
  if (out.firm.value) customerCites('firm');
  return verdict(failures);
}

/** Flattens the cited output for the workflow. Fields that failed verification become null (firm: false). */
export function groundIntake(out: IntakeCited, facts: Fact[]): { fields: IntakeFields; cites: Record<string, string[]>; dropped: string[]; verdict: Verdict } {
  const v = verifyIntake(out, facts);
  const dropped = [...new Set(v.failures.map((f) => f.field))];
  const fields = Object.fromEntries(Object.entries(out).map(([k, c]) => [k, dropped.includes(k) ? (k === 'firm' ? false : null) : c.value])) as IntakeFields;
  const cites = Object.fromEntries(Object.entries(out).filter(([k, c]) => !dropped.includes(k) && c.value !== null && c.value !== false).map(([k, c]) => [k, c.cites]));
  return { fields, cites, dropped, verdict: v };
}

// ---- 2. Clarification ----

export interface ClarifyCited {
  question: string | null;
  cites: string[];
}

/** Runs before the existing leaksInQuestion(). Any failure means: send templateQuestion(). */
export function verifyClarify(out: ClarifyCited, facts: Fact[]): Verdict {
  if (out.question === null) return verdict([{ code: 'ABSTAINED', field: 'question', detail: 'the model reported insufficient data' }]);
  const failures: Failure[] = [];
  const leak = leakFailure(out.question, 'question', true);
  if (leak.length) return verdict(leak); // checked first: the audit row says "prompt-leak attempt"
  const cited = resolveCites(out.cites, index(facts), 'question', 1, failures);
  failures.push(...groundedText(out.question, cited, 'question'), ...lintSlop(out.question, 'question', 'customer'));
  return verdict(failures);
}

// ---- 3. Finance referral ----

/** Judging words: no agent may say whether a document or claim is real. Only a person records Genuine or Fake. */
const VERDICT_TERMS = [...VERDICT_WORDS, 'real', 'valid', 'invalid', 'counterfeit', 'bogus', 'tampered', 'fabricated', 'faked', 'doctored', 'trustworthy', 'untrustworthy', 'credible', 'suspicious', 'false', 'true'];
const VERDICT_RE = new RegExp(`\\b(?:${VERDICT_TERMS.join('|')})\\b`, 'i');

export interface Claim {
  text: string;
  cites: string[];
}

export interface FinanceCited {
  dataStatus: 'sufficient' | 'insufficient';
  missing: string[];
  summary: Claim[];
  considerations: Claim[];
}

const COMPARE: [RegExp, (a: number, b: number) => boolean][] = [
  [/\bat or above\b|\bat least\b|\bnot below\b/i, (a, b) => a >= b],
  [/\bat or below\b|\bat most\b|\bnot above\b/i, (a, b) => a <= b],
  [/\babove\b|\bover the\b|\bmore than\b|\bhigher than\b|\bgreater than\b|\bexceeds?\b/i, (a, b) => a > b],
  [/\bbelow\b|\bunder the\b|\bless than\b|\blower than\b|\bfewer than\b|\bshort of\b/i, (a, b) => a < b],
  [/\bequal to\b|\bsame as\b|\bequals\b/i, (a, b) => a === b],
];

/**
 * A statement that compares two things must state both figures, from the cited facts, and the
 * comparison must hold for them in the order written ("₹9,75,000, below the ₹10,00,000 threshold").
 * A comparison with no figures ("the margin is above the minimum") is refused: nothing checks it.
 */
export function comparisonFailure(text: string, cited: Fact[], field: string): Failure | null {
  const rule = COMPARE.find(([re]) => re.test(text));
  if (!rule) return null;
  const allowed = allowedNumbers(cited);
  const figures = numbersIn(text).filter((n) => allowed.has(n));
  if (figures.length < 2) return { code: 'UNSUPPORTED_VALUE', field, detail: 'a comparison must state both cited figures' };
  const pos = text.search(rule[0]);
  const before = numbersIn(text.slice(0, pos)).filter((n) => allowed.has(n));
  const after = numbersIn(text.slice(pos)).filter((n) => allowed.has(n));
  const a = before.at(-1);
  const b = after[0];
  if (a === undefined || b === undefined) return { code: 'UNSUPPORTED_VALUE', field, detail: 'a comparison must state a cited figure on each side' };
  return rule[1](a, b) ? null : { code: 'UNSUPPORTED_VALUE', field, detail: `the comparison does not hold for ${a} and ${b}` };
}

/** Any failure means: store templateFinanceCase(facts) and set meta.fallback. */
export function verifyFinance(out: FinanceCited, facts: Fact[]): Verdict {
  const byId = index(facts);
  const failures: Failure[] = [];
  const claims: [string, Claim][] = [...out.summary.map((c, i) => [`summary[${i}]`, c] as [string, Claim]), ...out.considerations.map((c, i) => [`considerations[${i}]`, c] as [string, Claim])];

  if (out.summary.length === 0) failures.push({ code: 'BAD_SHAPE', field: 'summary', detail: 'empty' });
  for (const [field, claim] of claims) {
    failures.push(...leakFailure(claim.text, field, false));
    for (const id of claim.cites) if (isClaimFact(id)) failures.push({ code: 'CITES_CLAIM', field, detail: `${id} is a buyer claim, not a fact` });
    const cited = resolveCites(claim.cites, byId, field, 1, failures).filter((f) => !isClaimFact(f));
    failures.push(...groundedText(claim.text, cited, field), ...lintSlop(claim.text, field, 'finance'));
    const verdictWord = claim.text.match(VERDICT_RE);
    if (verdictWord) failures.push({ code: 'VERDICT', field, detail: `"${verdictWord[0]}"` });
    const rival = claim.text.match(RIVAL_RE);
    if (rival) failures.push({ code: 'CITES_CLAIM', field, detail: `"${rival[0]}": a buyer claim is not part of the case` });
    const cmp = comparisonFailure(claim.text, cited, field);
    if (cmp) failures.push(cmp);
  }

  const nullRequired = facts.filter((f) => f.required && f.value === null).map((f) => f.id);
  const missing = new Set(out.missing);
  if (nullRequired.length !== missing.size || nullRequired.some((id) => !missing.has(id)))
    failures.push({ code: 'DATA_STATUS_MISMATCH', field: 'missing', detail: `expected [${nullRequired.join(', ')}], got [${out.missing.join(', ')}]` });
  if ((out.dataStatus === 'insufficient') !== nullRequired.length > 0) failures.push({ code: 'DATA_STATUS_MISMATCH', field: 'dataStatus', detail: `${out.dataStatus} with ${nullRequired.length} required facts missing` });

  const citedIds = new Set(claims.flatMap(([, c]) => c.cites));
  for (const f of facts) if (f.required && !citedIds.has(f.id)) failures.push({ code: 'MISSING_REQUIRED_CITE', field: 'summary', detail: `${f.id} (${f.key}) is cited nowhere` });
  return verdict(failures);
}

/** Indian digit grouping: 1353000 -> ₹13,53,000. */
const rupees = (n: number) => {
  const w = String(Math.round(Math.abs(n)));
  return `₹${w.length <= 3 ? w : `${w.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${w.slice(-3)}`}`;
};

/**
 * The case code writes when the model's draft fails verification. It is built from the same fact
 * list and passes verifyFinance by construction (asserted in the tests).
 */
export function templateFinanceCase(facts: Fact[]): FinanceCited {
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const id = (key: string) => byKey.get(key)?.id ?? '';
  const val = (key: string) => byKey.get(key)?.value ?? null;
  const num = (key: string) => val(key) as number;
  const claim = (text: string, keys: string[]): Claim => ({ text, cites: keys.map(id).filter(Boolean) });

  const asked = rupees(num('price.requested'));
  const contract = rupees(num('price.contract'));
  const who = val('request.by') === 'sales' ? `Sales wants to offer ${val('account.name')}` : `${val('account.name')} asks`;
  const summary: Claim[] = [
    claim(`${who} ${asked} each for ${num('quote.quantity')} × ${val('item.code')}. Contract price is ${contract}.`, ['request.by', 'account.name', 'price.requested', 'quote.quantity', 'item.code', 'price.contract']),
    claim(`Margin at ${asked} is ${num('margin.atRequestedPct')}% against a ${num('margin.minimumPct')}% minimum.`, ['price.requested', 'margin.atRequestedPct', 'margin.minimumPct']),
  ];

  const epReq = val('expectedProfit.atRequested');
  const epCon = val('expectedProfit.atContract');
  const epKeys = ['expectedProfit.atRequested', 'price.requested', 'expectedProfit.atContract', 'price.contract'];
  if (epReq === null && epCon === null) summary.push(claim('Expected gross profit is not on record at either price: not enough past quotes.', epKeys));
  else if (epReq === null) summary.push(claim(`Expected gross profit at ${asked} is not on record. It is ${rupees(num('expectedProfit.atContract'))} at ${contract}.`, epKeys));
  else if (epCon === null) summary.push(claim(`Expected gross profit is ${rupees(num('expectedProfit.atRequested'))} at ${asked}. It is not on record at ${contract}.`, epKeys));
  else summary.push(claim(`Expected gross profit is ${rupees(num('expectedProfit.atRequested'))} at ${asked} and ${rupees(num('expectedProfit.atContract'))} at ${contract}.`, epKeys));

  const paid = val('history.avgPaymentDays') === null ? 'Payment days are not on record.' : `Payment takes ${num('history.avgPaymentDays')} days on average.`;
  summary.push(claim(`Lifetime revenue is ${rupees(num('history.lifetimeRevenue'))} over ${num('history.orders')} orders. ${paid}`, ['history.lifetimeRevenue', 'history.orders', 'history.avgPaymentDays']));

  const threshold = rupees(num('policy.newCustomerOrderThreshold'));
  const value = rupees(num('policy.orderValue'));
  const ruleKeys = ['policy.newCustomer', 'policy.newCustomerDiscountAllowed', 'policy.orderValue', 'policy.newCustomerOrderThreshold', 'policy.yearVolumeCommitted'];
  const rule = !val('policy.newCustomer')
    ? 'Not a new customer, so the new-customer rule does not apply.'
    : val('policy.newCustomerDiscountAllowed')
      ? val('policy.yearVolumeCommitted')
        ? `New customer. Sales committed a year's volume, so the rule allows a discount. Order value is ${value}.`
        : `New customer. Order value is ${value}, at or above the ${threshold} threshold, so the rule allows a discount.`
      : `New customer. Order value is ${value}, below the ${threshold} threshold, and no year's volume is committed. The rule allows no discount.`;
  summary.push(claim(rule, ruleKeys));

  // Win-rate ranges at both prices, when the sample is large enough.
  const considerations: Claim[] = [];
  const range = (low: string, high: string, count: string, price: string, label: string) => {
    if (val(low) === null || val(high) === null || val(count) === null) return;
    considerations.push(claim(`Win rate at ${label} is ${num(low)}% to ${num(high)}% over ${num(count)} past quotes.`, [low, high, count, price]));
  };
  range('winRate.atRequested.lowPct', 'winRate.atRequested.highPct', 'pastQuotes.atRequested.count', 'price.requested', asked);
  range('winRate.atContract.lowPct', 'winRate.atContract.highPct', 'pastQuotes.atContract.count', 'price.contract', contract);
  const profitRange = (low: string, high: string, price: string, label: string) => {
    if (val(low) === null || val(high) === null) return;
    considerations.push(claim(`Expected gross profit at ${label} is ${rupees(num(low))} to ${rupees(num(high))}.`, [low, high, price]));
  };
  profitRange('expectedProfit.atRequested.low', 'expectedProfit.atRequested.high', 'price.requested', asked);
  profitRange('expectedProfit.atContract.low', 'expectedProfit.atContract.high', 'price.contract', contract);

  const missing = facts.filter((f) => f.required && f.value === null).map((f) => f.id);
  return { dataStatus: missing.length ? 'insufficient' : 'sufficient', missing, summary, considerations: considerations.slice(0, 5) };
}

// ---- 4. Decline reader ----

export interface DeclineCited {
  decision: Cited<ReplyDecision>;
  reason: { value: LossReason | null; cites: string[]; evidence: string | null };
}

export interface DeclineOutput {
  decision: ReplyDecision;
  reason: LossReason | null;
  evidence: string | null;
}

const isReplyFact = (f: Fact) => f.key.startsWith('reply.');

export function verifyDecline(out: DeclineCited, facts: Fact[]): Verdict {
  const byId = index(facts);
  const failures: Failure[] = [];

  // "question" is the abstain value: it needs no cite, but any cite it gives must exist.
  const decided = out.decision.value !== 'question';
  const cited = resolveCites(out.decision.cites, byId, 'decision', decided ? 1 : 0, failures);
  if (decided && cited.length > 0 && !cited.every(isReplyFact)) failures.push({ code: 'WRONG_CITE_KIND', field: 'decision', detail: 'accept and decline must cite reply sentences only' });

  const { value, cites, evidence } = out.reason;
  if (value !== null) {
    if (out.decision.value !== 'decline') failures.push({ code: 'BAD_SHAPE', field: 'reason', detail: 'a reason is only valid on a decline' });
    if (!(LOSS_REASONS as readonly string[]).includes(value)) failures.push({ code: 'BAD_SHAPE', field: 'reason', detail: `unknown reason ${value}` });
    const before = failures.length;
    const reasonCited = resolveCites(cites, byId, 'reason', 1, failures).filter(isReplyFact);
    if (failures.length === before && reasonCited.length === 0) failures.push({ code: 'WRONG_CITE_KIND', field: 'reason', detail: 'must cite a reply sentence' });
    const quote = evidence?.trim() ?? '';
    if (quote.length < 3) failures.push({ code: 'EVIDENCE_NOT_IN_FACT', field: 'reason', detail: 'no evidence quoted' });
    else if (!reasonCited.some((f) => String(f.value).includes(quote))) failures.push({ code: 'EVIDENCE_NOT_IN_FACT', field: 'reason', detail: `"${quote.slice(0, 60)}" is not an exact part of a cited sentence` });
  }
  return verdict(failures);
}

/**
 * Flattens for the workflow. A decision that fails becomes "question" (Sales reads the reply). A
 * reason that fails becomes null (Sales tags it by hand). The existing gateDecision() still runs
 * on the result.
 */
export function groundDecline(out: DeclineCited, facts: Fact[]): { output: DeclineOutput; cites: { decision: string[]; reason: string[] }; verdict: Verdict } {
  const v = verifyDecline(out, facts);
  const failed = (field: string) => v.failures.some((f) => f.field === field);
  const decision: ReplyDecision = failed('decision') ? 'question' : out.decision.value;
  const keepReason = decision === 'decline' && out.reason.value !== null && !failed('reason');
  return {
    output: { decision, reason: keepReason ? out.reason.value : null, evidence: keepReason ? (out.reason.evidence?.trim() ?? null) : null },
    cites: { decision: failed('decision') ? [] : out.decision.cites, reason: keepReason ? out.reason.cites : [] },
    verdict: v,
  };
}

// ---- 5. Claim evidence reader ----

export interface EvidenceInput {
  rfq: { itemCode: string | null; quantity: number | null; deliverBy: string | null };
  attachment: string;
}

/** F1 to F3 the request, D* the document sentences. */
export function evidenceFacts(input: EvidenceInput): Fact[] {
  return [
    { id: 'F1', key: 'rfq.itemCode', value: input.rfq.itemCode },
    { id: 'F2', key: 'rfq.quantity', value: input.rfq.quantity },
    { id: 'F3', key: 'rfq.deliverBy', value: input.rfq.deliverBy },
    ...segments('D', 'attachment.segment', input.attachment),
  ];
}

export interface Finding {
  text: string;
  cites: string[];
  quote: string;
}

const isDocFact = (f: Fact) => f.key === 'attachment.segment';

/** One finding: cites a document sentence, quotes it exactly, states only cited values, judges nothing. */
export function verifyFinding(f: Finding, facts: Fact[], field = 'finding'): Verdict {
  const failures: Failure[] = [];
  const cited = resolveCites(f.cites, index(facts), field, 1, failures);
  const docs = cited.filter(isDocFact);
  if (failures.length === 0 && docs.length === 0) failures.push({ code: 'WRONG_CITE_KIND', field, detail: 'must cite a document sentence' });
  const quote = f.quote.trim();
  if (quote.length < 3 || !docs.some((d) => String(d.value).includes(quote))) failures.push({ code: 'EVIDENCE_NOT_IN_FACT', field, detail: `"${quote.slice(0, 60)}" is not an exact part of a cited sentence` });
  const m = f.text.match(VERDICT_RE);
  if (m) failures.push({ code: 'VERDICT', field, detail: `"${m[0]}"` });
  failures.push(...leakFailure(f.text, field, false), ...groundedText(f.text, cited, field), ...lintSlop(f.text, field, 'finance'));
  return verdict(failures);
}

/** Keeps the findings that pass; returns the rest as dropped with their reason (for the audit row). */
export function groundEvidence(findings: Finding[], facts: Fact[]): { kept: Finding[]; dropped: { finding: Finding; reason: string }[] } {
  const kept: Finding[] = [];
  const dropped: { finding: Finding; reason: string }[] = [];
  findings.slice(0, PROMPT_LIMITS.evidenceFindings).forEach((f, i) => {
    const v = verifyFinding(f, facts, `findings[${i}]`);
    if (v.ok) kept.push({ ...f, quote: f.quote.trim() });
    else dropped.push({ finding: f, reason: v.reason ?? 'failed' });
  });
  return { kept, dropped };
}

/** Facts a person's reason may not rest on: who asked and the reason the buyer gave are the buyer's side, not Dhruva's records. */
export const NOT_CITABLE = new Set(['F4', 'F5']);

/**
 * A person's reason for a discount (Finance, or the rep after the Finance deadline) must cite the
 * facts it relied on: ids from the case's fact list that hold a value, never a buyer claim or the
 * buyer's stated reason, and at least one of Dhruva's records (win rate W, history H or policy P).
 * Null when valid.
 */
export function checkReasonCites(factIds: unknown, facts: Fact[]): { code: string; error: string } | null {
  if (!Array.isArray(factIds) || factIds.length === 0 || !factIds.every((x) => typeof x === 'string')) return { code: 'CITES_REQUIRED', error: 'Pick the facts the reason relies on' };
  if (factIds.length > PROMPT_LIMITS.citesPerItem) return { code: 'CITES_REQUIRED', error: `At most ${PROMPT_LIMITS.citesPerItem} facts` };
  const byId = index(facts);
  for (const id of factIds as string[]) {
    if (isClaimFact(id)) return { code: 'CLAIM_CITED', error: `${id} is a buyer claim, not a fact` };
    const f = byId.get(id);
    if (!f) return { code: 'UNKNOWN_FACT', error: `${id} is not in this case` };
    if (NOT_CITABLE.has(id)) return { code: 'NOT_CITABLE', error: `${id} is what the buyer said, not one of our records` };
    if (f.value === null) return { code: 'NO_VALUE', error: `${id} has no value on record` };
  }
  if (!(factIds as string[]).some((id) => /^[WHP]\d/.test(id))) return { code: 'NEEDS_RECORD', error: 'Cite at least one win-rate, history or policy fact' };
  return null;
}
