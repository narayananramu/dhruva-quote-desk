/**
 * Buyer claims, fake-rival alerts and probe detection (docs/DESIGN.md 7.6 and 7.7, ADVERSARIAL.md).
 *
 * Pure functions only: no I/O, no clock. The workflow bundle imports the counter and claim detectors,
 * so keep this file free of Node imports.
 *
 * Rule: a claim is never a fact. No pricing function takes a claim or an alert (domain.ts priceFacts
 * has no such argument), so a fake rival price buys nothing whatever the alert says. Signals and the
 * level only decide what Finance looks at before deciding.
 */

// ---- Thresholds (versioned; Finance owns changes, after 50 marked alerts) ----

export const ALERT_THRESHOLDS = {
  version: 'alerts-2026-11',
  likelyFakeWeak: 3, // three weak signals, or any strong one, give "likely fake"
  checkWeak: 1, // one or two weak signals give "check"
  belowHistoryPct: 10, // a claimed price this far under the lowest past price for the part group is a weak signal
} as const;

export type AlertLevel = 'likely_fake' | 'check' | 'no_concern';
export type SignalWeight = 'strong' | 'weak';
export type SignalId = 'below_cost' | 'attachment_instructions' | 'gstin_invalid' | 'below_history' | 'unknown_rival' | 'terms_mismatch' | 'tax_math' | 'group_fakes' | 'document_inconsistency';

export interface Signal {
  id: SignalId;
  weight: SignalWeight;
  text: string; // plain sentence for Finance
  evidence: string; // what it rests on: a quoted sentence, or the record it compared
  cites: string[]; // fact ids or document sentence ids
}

export interface ClaimInput {
  rival: string | null;
  rivalGstin: string | null;
  claimedPrice: number | null;
  attachmentText: string | null;
}

/** Dhruva's own records the signals compare a claim against. Never shown to the buyer. */
export interface ClaimContext {
  unitCost: number;
  lowestPastPrice: number | null; // lowest won or lost price in the part group, last 12 months
  competitors: { name: string; gstin: string | null }[]; // CRM list for the part group
  rfq: { itemCode: string | null; quantity: number | null };
  groupConfirmedFakes: number;
}

// ---- GSTIN (15 characters, mod-36 check character) ----

const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The check character for the first 14 characters of a GSTIN. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = B36.indexOf(first14[i] ?? '0');
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return B36[(36 - (sum % 36)) % 36]!;
}

export const withGstinCheck = (first14: string) => `${first14}${gstinCheckChar(first14)}`;

export function gstinValid(g: string): boolean {
  const s = g.trim().toUpperCase();
  return GSTIN_SHAPE.test(s) && gstinCheckChar(s.slice(0, 14)) === s[14];
}

// ---- Instruction text, counters and claims in customer text ----

/** Instruction-like text inside a document: a strong sign it was made to steer a reader or an agent. */
const DOC_INSTRUCTION = [
  /\b(mark|treat|record|flag) (this|it|the quote|the document) as (genuine|real|verified|authentic|valid)\b/i,
  /\b(finance|management|sales) (has )?(approved|authori[sz]ed)\b/i,
  /\bignore\b[^.\n]{0,40}?\b(instructions|policy|policies|rules|checks?)\b/i,
  /\b(approve|authori[sz]e|accept) (this|the) (price|discount|quote|claim)\b/i,
  /\b(system prompt|you are now|as an ai|assistant:)\b/i,
  /\bclassify (this|it|the) [^.\n]{0,40}?\bas\b/i,
  /\b(do not|don't|never) (flag|alert|report|escalate|question)\b/i,
  /\b(raise|create|send) no (alert|flag|warning)\b/i,
  /\b(alert|risk|fraud) level\b/i,
  /\bno concern\b/i,
  /(^|\n)\s*(system|developer|assistant)\s*:/i,
];

export function instructionIn(text: string | null): string | null {
  if (!text) return null;
  for (const re of DOC_INSTRUCTION) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

// A rival in plain words: "rival", "competitor", "another vendor", "our other supplier", or a firm name
// such as "Bharat Valves" or "Coastal Valves Pvt".
const RIVAL = String.raw`(?:rivals?|competitors?|competition|(?:an|another|other|second|alternate|alternative|different) (?:supplier|vendor|seller|manufacturer|dealer|distributor|company|firm|source)s?|[A-Z][A-Za-z]+ (?:Industries|Traders|Trading|Bearings|Valves|Seals|Gaskets|Pumps|Engineering|Enterprises|Corporation|Corp|Ltd|Limited|Pvt|Steel|Components)\b)`;
const MONEY = String.raw`(?:₹|\brs\.?|\binr)\s*(?<price>\d[\d,]*)`;
const VERB = String.raw`(?:quoted|quotes?|quoting|offer(?:s|ed|ing)?|pric(?:e|es|ed|ing)|charg(?:e|es|ed|ing)|gave|give[sn]?|giving|sell(?:s|ing)?|sold|bid|is|at|for|of)`;
const CLAIM_PATTERNS = [
  // "Rival quoted Rs 850", "Competitor price is Rs 850", "Bharat Valves gave us Rs 850 each", "Our other supplier charges Rs 850"
  new RegExp(String.raw`\b${RIVAL}[^.\n\d₹]{0,40}?\b${VERB}\b[^.\n\d₹]{0,20}?${MONEY}`, 'i'),
  // "a quote of Rs 850 from another vendor", "a written offer for INR 850 per unit from Coastal Valves"
  new RegExp(String.raw`${MONEY}[^.\n\d₹]{0,40}?\b(?:from|by|with)\s+(?:a |an |the |our |one )?${RIVAL}`, 'i'),
  // "Rs 850 is what the competitor quoted"
  new RegExp(String.raw`${MONEY}[^.\n\d₹]{0,30}?\b${RIVAL}[^.\n\d₹]{0,15}?\b(?:quoted|offered|charges|gave|sells|is selling)\b`, 'i'),
];

/**
 * A rival price in customer text, in either order: "rival quoted Rs 850", "a quote of Rs 850 from
 * another vendor". Returns the claimed unit price. A miss only means the claim is not logged; no
 * price ever depends on it.
 */
export function rivalClaimIn(text: string | null | undefined): { price: number; phrase: string } | null {
  if (!text) return null;
  let best: { price: number; phrase: string; at: number } | null = null;
  for (const re of CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (!m?.groups?.price) continue;
    const price = Number(m.groups.price.replace(/,/g, ''));
    if (Number.isFinite(price) && price > 0 && (best === null || m.index < best.at)) best = { price, phrase: m[0], at: m.index };
  }
  return best ? { price: best.price, phrase: best.phrase } : null;
}

/** A reply to a sent quote that asks for a different price: a counter. Code reads it; no agent decides. */
const COUNTER = /(₹|\brs\.?\s?\d|\binr\s?\d)|\b(discount|lower|reduce|reduction|match|best price|better price|cheaper|counter|too (high|expensive)|bring (it|the price) down|come down|negotiat\w*)\b/i;
/** A bare figure asked as a price, with no rupee sign: "Can you do 850 each?", "850 per unit", "would you take 950?". */
const BARE_PRICE = [
  /\b\d[\d,]*\s*(?:each|apiece|a piece|per (?:unit|piece|pc|item|no)|\/\s*(?:unit|pc|piece|no))\b/i,
  /\b(?:can|could|would|will) you (?:do|go(?: to)?|make it|offer|quote|give (?:it|us|me)?(?: for| at)?|sell (?:it |them )?(?:for|at)|take|accept|match)\s+(?:it |them )?(?:for |at )?\d[\d,]*(?![\d,]*\s*(?:units?|pcs|pieces|nos|days?|weeks?|months?|%))\b/i,
  /\b(?:price|rate|offer) (?:of |at |to )?\d[\d,]*\b(?!\s*(?:units?|pcs|pieces|nos|days?|weeks?|%))/i,
];
/** A plain number below the sent price that is not a quantity, date or term: read as a price ask. */
function figureBelow(text: string, sentPrice: number): boolean {
  const plain = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi, ' ')
    .replace(/\b[A-Z]{2,5}-\d{2,3}(?:-[A-Z]{2})?\b/g, ' ')
    .replace(/\b(?:Q|SO|RFQ|PO)-[A-Z0-9-]+\b/g, ' ');
  for (const m of plain.matchAll(/\b(\d[\d,]*)\b(?!\s*(?:units?|pcs|pieces|nos|days?|weeks?|months?|mm|%|x\b|×))/gi)) {
    const before = plain.slice(Math.max(0, m.index - 12), m.index);
    if (/\b(?:deliver|send|ship|supply|need|want|order|only|another|first|in|within|net)\s*$/i.test(before)) continue;
    const n = Number(m[1]!.replace(/,/g, ''));
    if (n >= sentPrice * 0.5 && n < sentPrice) return true;
  }
  return false;
}
/**
 * A reply that asks for a different price. With the sent price, a plain figure below it counts too, so a
 * counter typed without a rupee sign gets the same reply as any other.
 */
export const isCounter = (text: string | null | undefined, sentPrice?: number): boolean =>
  !!text && (COUNTER.test(text) || BARE_PRICE.some((re) => re.test(text)) || (sentPrice !== undefined && figureBelow(text, sentPrice)));

/**
 * A request for the agents' instructions, in plain words, translated or encoded. Counted toward the
 * buyer group's probing score; the text is still only data to the agents.
 */
const PROMPT_PROBE = [
  /\b(system|initial|hidden|original) (prompt|instructions)\b/i,
  /\b(print|show|reveal|repeat|output|tell me|list|give me|share|send me|dump)\b[^.\n?]{0,30}\byour (instructions|prompt|configuration|config)\b/i,
  /\bwhat are your (rules|instructions)\s*\?/i,
  /\bignore (all |any |the |your )?(previous|prior|above|earlier) (instructions|rules|messages)\b/i,
  /\brepeat (the|everything) (text|words)? ?(above|before)\b/i,
  /\b(instructions|consignes|instrucciones|anweisungen|istruzioni|regeln|règles|reglas)\b[^.\n]{0,30}\b(système|sistema|system|prompt)\b/i,
  /(अपने निर्देश|सिस्टम प्रॉम्प्ट|नियम बताओ)/,
  /(系统提示|你的指令|プロンプト)/,
];

function decodedVariants(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? []) {
    try {
      const s = atob(chunk);
      if (/^[\x20-\x7E\s]+$/.test(s)) out.push(s);
    } catch {
      // not base64
    }
  }
  const rot = text.replace(/[a-z]/gi, (c) => {
    const b = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
  });
  out.push(rot);
  const hex = text.match(/(?:[0-9a-f]{2}\s?){12,}/i)?.[0];
  if (hex) out.push(hex.replace(/\s/g, '').replace(/../g, (h) => String.fromCharCode(parseInt(h, 16))));
  return out;
}

export function promptProbe(text: string | null | undefined): { phrase: string; encoded: boolean } | null {
  if (!text) return null;
  for (const re of PROMPT_PROBE) {
    const m = text.match(re);
    if (m) return { phrase: m[0], encoded: false };
  }
  for (const d of decodedVariants(text)) {
    for (const re of PROMPT_PROBE) {
      const m = d.match(re);
      if (m) return { phrase: m[0], encoded: true };
    }
  }
  return null;
}

// ---- Signals (each a pure function of the claim and Dhruva's records) ----

const PART = /\b[A-Z]{2,5}-\d{2,3}(?:-[A-Z]{2})?\b/g;
const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

export function claimSignals(c: ClaimInput, ctx: ClaimContext): Signal[] {
  const s: Signal[] = [];
  const doc = c.attachmentText ?? '';
  if (c.claimedPrice !== null && c.claimedPrice < ctx.unitCost)
    s.push({ id: 'below_cost', weight: 'strong', text: `Claimed price ${rupees(c.claimedPrice)} is below our unit cost ${rupees(ctx.unitCost)}.`, evidence: `cost ${rupees(ctx.unitCost)}`, cites: ['X1', 'F8'] });
  const ins = instructionIn(doc);
  if (ins) s.push({ id: 'attachment_instructions', weight: 'strong', text: 'The document contains instructions to the reader.', evidence: ins, cites: ['D'] });
  const listed = c.rival ? ctx.competitors.find((k) => k.name.toLowerCase() === c.rival!.trim().toLowerCase()) : undefined;
  if (c.rivalGstin) {
    const g = c.rivalGstin.trim().toUpperCase();
    if (!gstinValid(g)) s.push({ id: 'gstin_invalid', weight: 'strong', text: "The rival's GSTIN fails its check character.", evidence: g, cites: ['X2'] });
    else if (listed?.gstin && listed.gstin !== g) s.push({ id: 'gstin_invalid', weight: 'strong', text: "The rival's GSTIN differs from the one on record.", evidence: `${g} vs ${listed.gstin}`, cites: ['X2'] });
  }
  if (c.claimedPrice !== null && ctx.lowestPastPrice !== null && c.claimedPrice < ctx.lowestPastPrice * (1 - ALERT_THRESHOLDS.belowHistoryPct / 100))
    s.push({ id: 'below_history', weight: 'weak', text: `Claimed price is more than ${ALERT_THRESHOLDS.belowHistoryPct}% under the lowest price in our past quotes for the part group.`, evidence: `lowest ${rupees(ctx.lowestPastPrice)}`, cites: ['X1', 'W'] });
  if (c.rival && !listed) s.push({ id: 'unknown_rival', weight: 'weak', text: 'The rival is not on our competitor list for this part group.', evidence: c.rival, cites: ['X3'] });
  if (doc) {
    const parts = [...new Set(doc.match(PART) ?? [])];
    const qty = doc.match(/(\d[\d,]*)\s*(?:units?|pcs|pieces|nos)\b/i);
    const q = qty ? Number(qty[1]!.replace(/,/g, '')) : null;
    if ((ctx.rfq.itemCode && parts.length && !parts.includes(ctx.rfq.itemCode)) || (ctx.rfq.quantity && q !== null && q !== ctx.rfq.quantity))
      s.push({ id: 'terms_mismatch', weight: 'weak', text: 'The part or quantity in the document differs from the request.', evidence: [parts.join(', '), q !== null ? `${q} units` : ''].filter(Boolean).join('; '), cites: ['D', 'F1', 'F2'] });
    const tax = doc.match(/sub-?total[^\d]{0,15}([\d,]+)[\s\S]{0,80}?gst[^\d]{0,15}(?:\d{1,2}\s?%[^\d]{0,10})?([\d,]+)[\s\S]{0,80}?total[^\d]{0,15}([\d,]+)/i);
    if (tax) {
      const [sub, gst, tot] = [tax[1]!, tax[2]!, tax[3]!].map((x) => Number(x.replace(/,/g, ''))) as [number, number, number];
      if (sub + gst !== tot) s.push({ id: 'tax_math', weight: 'weak', text: 'The tax arithmetic in the document does not add up.', evidence: `${sub} + ${gst} ≠ ${tot}`, cites: ['D'] });
    }
  }
  if (ctx.groupConfirmedFakes > 0) s.push({ id: 'group_fakes', weight: 'weak', text: 'The buyer group has confirmed fake claims on record.', evidence: `${ctx.groupConfirmedFakes} confirmed`, cites: ['G'] });
  return s;
}

/** One function maps signals to a level, from the versioned threshold table. */
export function alertLevel(signals: Pick<Signal, 'weight'>[]): AlertLevel {
  if (signals.some((s) => s.weight === 'strong')) return 'likely_fake';
  const weak = signals.filter((s) => s.weight === 'weak').length;
  if (weak >= ALERT_THRESHOLDS.likelyFakeWeak) return 'likely_fake';
  if (weak >= ALERT_THRESHOLDS.checkWeak) return 'check';
  return 'no_concern';
}

/**
 * Adds the evidence agent's verified findings as one weak signal. The agent has no level field and
 * this can only add a signal, so the level never falls because of a model.
 */
export function withFindings(signals: Signal[], findings: { text: string; quote: string; cites: string[] }[]): Signal[] {
  if (!findings.length) return signals;
  const f = findings[0]!;
  return [...signals, { id: 'document_inconsistency', weight: 'weak', text: f.text, evidence: f.quote, cites: f.cites }];
}

// ---- Alert metrics ----

export interface ReviewedAlert {
  level: AlertLevel;
  signals: SignalId[];
  review: 'correct' | 'wrong' | null;
  verification: 'genuine' | 'fake' | null;
}

/** Precision: alerts marked Correct over alerts marked. Recall: alerted share of confirmed fakes. */
export function alertMetrics(rows: ReviewedAlert[]) {
  const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : null);
  const alerted = (r: ReviewedAlert) => r.level !== 'no_concern';
  const marked = rows.filter((r) => alerted(r) && r.review !== null);
  const byLevel = Object.fromEntries(
    (['likely_fake', 'check'] as const).map((l) => {
      const m = marked.filter((r) => r.level === l);
      return [l, { marked: m.length, correct: m.filter((r) => r.review === 'correct').length, precision: ratio(m.filter((r) => r.review === 'correct').length, m.length) }];
    }),
  );
  const ids = [...new Set(rows.flatMap((r) => r.signals))];
  const bySignal = Object.fromEntries(
    ids.map((id) => {
      const m = marked.filter((r) => r.signals.includes(id));
      return [id, { marked: m.length, correct: m.filter((r) => r.review === 'correct').length, precision: ratio(m.filter((r) => r.review === 'correct').length, m.length) }];
    }),
  );
  const fakes = rows.filter((r) => r.verification === 'fake');
  return {
    alerts: rows.filter(alerted).length,
    marked: marked.length,
    correct: marked.filter((r) => r.review === 'correct').length,
    precision: ratio(marked.filter((r) => r.review === 'correct').length, marked.length),
    confirmedFakes: fakes.length,
    recall: ratio(fakes.filter(alerted).length, fakes.length),
    byLevel,
    bySignal,
    thresholdsVersion: ALERT_THRESHOLDS.version,
  };
}
