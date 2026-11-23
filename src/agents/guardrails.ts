import { LOSS_REASONS, PROMPT_LIMITS, type LossReason, type ReplyDecision } from './prompts';

/**
 * Code that backs every prompt rule (DESIGN.md 7.2). Pure functions: no I/O, no clock. The workflow
 * bundle imports `detectInjection` from here, so keep this file free of Node imports.
 */

export const QUESTION_LEAK =
  /₹|\brs\.?\s?\d|\binr\b|%|margin|cost|profit|discount|in stock|on hand|available|lead time|https?:|www\.|@|floor|minimum|finance|approv|price|pricing|\blist\b|\bbelow\b|\bcheaper\b|\boff\b|percent|\brules?\b|instruction|\bdeal\b/i;
export const ACCEPT_BLOCKERS = /\b(if|but|unless|only|provided|however|instead|not|no|can't|cannot|won't|cancel|decline|reject|lower|discount|cheaper)\b/i;
export const RECOMMEND_WORDS = /\b(recommend\w*|suggest\w*|advis\w*|should|must|worth|justif\w*|warrant\w*|i (approve|reject))\b/i;

// ---- 7.3 Instruction-like text ----

const INJECTION = [
  /ignore\b[^.\n]{0,40}?\b(policy|policies|instructions|rules)\b/i,
  /disregard\b[^.\n]{0,40}?\b(instructions|policy|rules)\b/i,
  /system prompt/i,
  /you are now/i,
  /(approve|authorise|authorize) this (price|discount|quote)/i,
];

/** Flags instruction-like text for the audit trail. Routing never depends on it. */
export function detectInjection(text: string | null | undefined): { phrase: string } | null {
  if (!text) return null;
  for (const re of INJECTION) {
    const m = text.match(re);
    if (m) {
      const phrase = m[0].replace(/\s+/g, ' ').trim();
      return { phrase: phrase.charAt(0).toUpperCase() + phrase.slice(1, 60) };
    }
  }
  return null;
}

// ---- A. Size ----

export function cutCustomerText(text: string): { text: string; truncated: boolean; originalChars: number } {
  const max = PROMPT_LIMITS.customerTextChars;
  return { text: text.length > max ? text.slice(0, max) : text, truncated: text.length > max, originalChars: text.length };
}

// ---- B. Intake post-check ----

export interface IntakeFields {
  account: string | null;
  partNumber: string | null;
  partDescription: string | null;
  quantity: number | null;
  firm: boolean;
  requestedUnitPrice: number | null;
  priceReason: 'competitor' | 'volume' | 'budget' | 'other' | null;
  deliverBy: string | null;
  deliverTo: string | null;
}

/** `exactPart` returns the catalogue part number for an exact (case-insensitive) match, else null. */
export function checkIntake(out: IntakeFields, ctx: { today: string; exactPart: (pn: string) => string | null }): { fields: IntakeFields; changed: string[] } {
  const f = { ...out };
  const changed: string[] = [];
  if (f.partNumber !== null) {
    const exact = ctx.exactPart(f.partNumber);
    if (exact) f.partNumber = exact;
    else {
      f.partDescription = (f.partDescription ?? f.partNumber).slice(0, 80);
      f.partNumber = null;
      changed.push('partNumber');
    }
  }
  if (f.requestedUnitPrice !== null) {
    const p = Math.round(f.requestedUnitPrice);
    if (!Number.isFinite(p) || p <= 0) {
      f.requestedUnitPrice = null;
      changed.push('requestedUnitPrice');
    } else f.requestedUnitPrice = p;
  }
  if (f.deliverBy !== null) {
    const max = new Date(Date.parse(`${ctx.today}T00:00:00Z`) + 366 * 86_400_000).toISOString().slice(0, 10);
    if (Number.isNaN(Date.parse(`${f.deliverBy}T00:00:00Z`)) || f.deliverBy < ctx.today || f.deliverBy > max) {
      f.deliverBy = null;
      changed.push('deliverBy');
    }
  }
  if (f.quantity !== null && !(Number.isInteger(f.quantity) && f.quantity >= 1 && f.quantity <= 100_000)) {
    f.quantity = null;
    changed.push('quantity');
  }
  if (f.deliverTo !== null && placeOrNull(f.deliverTo) === null) {
    f.deliverTo = null;
    changed.push('deliverTo');
  }
  return { fields: f, changed };
}

// ---- C. Clarification post-check ----

export interface ClarificationInput {
  reason: 'part' | 'account' | 'quantity';
  ownAccountName: string;
  options: { partNumber: string; description: string }[];
  quantity: number | null;
}

/** The fixed question code sends when the model's question fails a check (or is not called). */
export function templateQuestion(i: ClarificationInput): string {
  switch (i.reason) {
    case 'part':
      return i.options.length
        ? i.options.length === 2
          ? `Which part do you need: ${i.options[0]!.partNumber} (${i.options[0]!.description}) or ${i.options[1]!.partNumber} (${i.options[1]!.description})?`
          : `Which part do you need: ${i.options.map((p) => `${p.partNumber} (${p.description})`).join(', ')}?`
        : 'Which part number do you need?';
    case 'account':
      return `We can only quote for the account you are signed in as, ${i.ownAccountName}. Please confirm this request is for ${i.ownAccountName}.`;
    case 'quantity':
      return `How many units${i.options[0] ? ` of ${i.options[0].partNumber}` : ''} do you need?`;
  }
}

const PART_NUMBER = /\b[A-Z]{2,5}-\d{2,3}(?:-[A-Z]{2})?\b/g;

/** Why a question may not go to the customer, or null when it is fine. */
export function leaksInQuestion(question: string, input: ClarificationInput, otherAccountNames: string[]): string | null {
  if (QUESTION_LEAK.test(question)) return 'QUESTION_LEAK';
  const lower = question.toLowerCase();
  for (const n of otherAccountNames) if (n && lower.includes(n.toLowerCase())) return 'OTHER_ACCOUNT';
  const allowed = new Set(input.options.map((o) => o.partNumber));
  for (const pn of question.match(PART_NUMBER) ?? []) if (!allowed.has(pn)) return 'UNKNOWN_PART';
  if (!input.options.every((o) => question.includes(o.partNumber))) return 'MISSING_OPTION';
  if ((question.match(/[.?!](\s|$)/g) ?? []).length > 2) return 'TOO_LONG';
  return null;
}

// ---- D. Decline reader gate ----

export interface DeclineOutput {
  decision: ReplyDecision;
  reason: LossReason | null;
  evidence: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** A figure in an acceptance ("We accept at Rs 900 each for 150 units") states terms of its own. */
export const ACCEPT_FIGURES = /[₹\d]|\brs\b|\binr\b/i;

/**
 * Booking a wrong order is the costly error, so the gate leans towards a person. The order is always
 * booked at the sent terms, so an acceptance that names any figure or condition goes to Sales.
 */
export function gateDecision(out: DeclineOutput, reply: string): DeclineOutput {
  let { decision, reason, evidence } = out;
  if (decision === 'accept' && (reply.length > 300 || ACCEPT_BLOCKERS.test(reply) || ACCEPT_FIGURES.test(reply))) decision = 'question';
  if (decision !== 'decline') reason = null;
  if (reason !== null && !(LOSS_REASONS as readonly string[]).includes(reason)) reason = null;
  if (reason === null || !evidence || !norm(reply).includes(norm(evidence))) {
    reason = null;
    evidence = null;
  }
  return { decision, reason, evidence };
}

const PLAIN_ACCEPT = new Set(['we accept', 'accepted', 'we accept the quote', 'we accept your quote', 'we accept this quote', 'yes we accept', 'we accept thank you', 'we accept thanks']);
const PLAIN_DECLINE = new Set(['we decline', 'declined', 'we decline the quote', 'we decline your quote', 'we decline this quote', 'we decline thank you', 'we decline thanks']);

/**
 * Code-only reading of a reply when no model may run (AI budget used up, or the decline reader
 * failed): only a short, plain acceptance or decline counts, matched exactly after punctuation and
 * case are dropped. Anything else is null and goes to a person.
 */
export function plainDecision(reply: string): 'accept' | 'decline' | null {
  const n = reply.toLowerCase().replace(/[.,!]/g, ' ').replace(/\s+/g, ' ').trim();
  if (n.length > 40) return null;
  if (PLAIN_ACCEPT.has(n)) return 'accept';
  if (PLAIN_DECLINE.has(n)) return 'decline';
  return null;
}

// ---- E. Finance referral: see grounding.ts (verifyFinance, templateFinanceCase) ----

/** Every number in the text must equal a value in the facts (commas and ₹ stripped, % allowed). */
export function ungroundedNumbers(text: string, facts: object): string[] {
  const allowed = new Set<number>();
  for (const v of Object.values(facts)) if (typeof v === 'number') allowed.add(v);
  // Item codes such as VLV-40 are names, not figures.
  const found = text.replace(PART_NUMBER, ' ').replace(/₹/g, ' ').match(/\d[\d,]*(\.\d+)?/g) ?? [];
  return found.filter((raw) => !allowed.has(Number(raw.replace(/,/g, ''))));
}

// ---- F. Customer-facing text ----

/** Words that tell a customer about Dhruva's limits. No outbound message may contain one (DECISIONS 11, threat 8). */
const OUTBOUND_WORDS = /\b(?:costs?|margins?|floors?|minimum|maximum|max discount|discount\w*|win[- ]?rates?|profit\w*|percent|per cent|lowest price|finance can|approv\w* down|rules?)\b|%/i;
const MONEY_FIGURE = /(?:₹|\brs\.?|\binr)\s*(\d[\d,]*(?:\.\d+)?)/gi;
const REFS = /\b(?:Q|SO|RFQ|PO)-[A-Z0-9-]+\b/g;
const TIMES = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(?:am|pm)\b/gi;
const DAY_MONTH = /\b\d{1,2}\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/g;
const ISO_DATES = /\b\d{4}-\d{2}-\d{2}\b/g;

export interface OutboundRules {
  /** Strict: every figure must be one of these (the issued price, quantity, total, delivery quantities, terms). Dates, times, references and part numbers are names. */
  numbers?: number[];
  /** Loose (free text such as a Sales question): a rupee figure must be one of these. */
  money?: number[];
  otherAccountNames?: string[];
}

/**
 * Code-level scan of every customer-facing text (DECISIONS 11). Null when the text may go out, else
 * the rule it broke. Runs on templates as a last check and on the only free text a person writes to
 * a customer (a Sales question).
 */
export function outboundProblem(text: string, rules: OutboundRules = {}): string | null {
  const w = text.match(OUTBOUND_WORDS);
  if (w) return `INTERNAL_WORD "${w[0]}"`;
  const lower = text.toLowerCase();
  for (const n of rules.otherAccountNames ?? []) if (n && lower.includes(n.toLowerCase())) return 'OTHER_ACCOUNT';
  if (rules.numbers) {
    const allowed = new Set(rules.numbers);
    const plain = text.replace(REFS, ' ').replace(PART_NUMBER, ' ').replace(ISO_DATES, ' ').replace(TIMES, ' ').replace(DAY_MONTH, ' ');
    for (const raw of plain.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
      const n = Number(raw.replace(/,/g, ''));
      if (!allowed.has(n)) return `UNKNOWN_NUMBER ${raw}`;
    }
  } else {
    const allowed = new Set(rules.money ?? []);
    for (const m of text.matchAll(MONEY_FIGURE)) {
      const n = Number(m[1]!.replace(/,/g, ''));
      if (!allowed.has(n)) return `PRICE_FIGURE ${m[0]}`;
    }
  }
  return null;
}

// ---- G. Delivery place ----

const PLACE_WORDS = /\b(?:price|prices|priced|rate|rates|rs|inr|rupees?|each|total|discount\w*|approv\w*|agreed|finance|offer\w*|quote\w*|order\w*|confirm\w*|ignore|instructions?|system|prompt)\b/i;

/**
 * A delivery place is printed on the quote and the order confirmation, so it is a place name only:
 * letters, spaces, commas, hyphens and apostrophes, at most six words, no figures, currency or
 * sentence punctuation, and none of the words a forged term would need. Null when it is not.
 */
export function placeOrNull(place: string | null | undefined): string | null {
  if (typeof place !== 'string') return null;
  const p = place.trim().replace(/\s+/g, ' ');
  if (!p || p.length > 60) return null;
  if (!/^\p{L}[\p{L} ,'-]*$/u.test(p)) return null;
  if (p.split(/[ ,]+/).filter(Boolean).length > 6) return null;
  if (PLACE_WORDS.test(p)) return null;
  return p;
}
