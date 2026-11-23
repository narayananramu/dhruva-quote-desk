import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { templateFinanceCase, type Fact } from './grounding';
import { templateQuestion, type ClarificationInput } from './guardrails';
import { CLARIFICATION_SYSTEM, DECLINE_READER_SYSTEM, EVIDENCE_SYSTEM, FINANCE_REFERRAL_SYSTEM, INTAKE_SYSTEM } from './prompts';

/**
 * Deterministic demo model (QUOTE_MODEL=mock). It runs through the real AI SDK path (tool calls,
 * schema checks, usage, the citation verifier) but answers with plain rules over the fact list, so
 * the demo runs with no API key and always lands in the same place. Every value it returns cites
 * the fact it came from, so its outputs pass the verifier. Token counts are estimated at 4
 * characters per token.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PART = /\b[A-Z]{2,5}-\d{2,3}(?:-[A-Z]{2})?\b/;
const tokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

type Msg = LanguageModelV4CallOptions['prompt'][number];

function textOf(m: Msg | undefined): string {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return (m.content as { type: string; text?: string }[]).map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('');
}

function result(text: string, prompt: string, toolCall?: { name: string; input: object }): LanguageModelV4GenerateResult {
  const out = toolCall ? JSON.stringify(toolCall.input) : text;
  const inputTokens = tokens(prompt);
  const outputTokens = tokens(out);
  return {
    content: toolCall
      ? [{ type: 'tool-call', toolCallId: `call-${inputTokens}`, toolName: toolCall.name, input: JSON.stringify(toolCall.input) }]
      : [{ type: 'text', text }],
    finishReason: toolCall ? { unified: 'tool-calls', raw: 'tool_calls' } : { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
    },
    warnings: [],
  };
}

const factsOf = (opts: LanguageModelV4CallOptions): Fact[] => (JSON.parse(textOf(opts.prompt.find((m) => m.role === 'user'))) as { facts: Fact[] }).facts;
const str = (f: Fact | undefined) => (f && typeof f.value === 'string' ? f.value : '');

// ---- Intake ----

function partQuery(text: string): string | null {
  const pn = text.match(PART);
  if (pn) return pn[0];
  // "sealed 25mm bearings", "25mm sealed bearing", "open bearing", "flange gaskets"
  const m = text.match(/((?:sealed|open)\s+)?(\d+\s?mm\s+)?((?:sealed|open|flange)\s+)?(bearing|valve|seal kit|o-ring|gasket|seal)s?\b/i);
  return m ? m[0].replace(/s$/i, '').trim() : null;
}

const UNIT = String.raw`(?:units?|pcs|pieces?|nos|numbers|×|x\s)`;
const NOUN = String.raw`(?:bearings?|valves?|gaskets?|seals?|seal kits?|o-rings?|kits?)`;
/**
 * A quantity in customer text. Prices, dates, sizes ("25mm"), terms ("in 7 days") and part codes are
 * removed first, so the figure left is an amount: "30 units", "x 30", "30 GSK-80 gaskets", "200 sealed
 * 25mm bearings", "we need 30". In a reply to a quantity question, a single plain figure is the answer.
 * Only digits: a number in words cannot be cited back to the text.
 */
export function quantityIn(text: string, reply: boolean): number | null {
  const n = (s: string) => Number(s.replace(/,/g, ''));
  const beforePart = text.match(new RegExp(String.raw`(\d[\d,]*)\s*(?:x\s*|×\s*)?${PART.source}`));
  const t = text
    .replace(/(?:₹|\brs\.?|\binr)\s*\d[\d,]*(?:\.\d+)?/gi, ' ')
    .replace(/\b\d[\d,]*\s*(?:each|per\s+\w+|\/\s*\w+)\b/gi, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi, ' ')
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/gi, ' ')
    .replace(/\b\d+\s?mm\b/gi, ' ')
    .replace(/\b\d+\s*(?:days?|weeks?|months?|%|percent)\b/gi, ' ')
    .replace(new RegExp(PART.source, 'g'), ' ');
  const pats = [
    new RegExp(String.raw`(\d[\d,]*)\s*${UNIT}`, 'i'),
    /(?:×|\bx)\s*(\d[\d,]*)/i,
    new RegExp(String.raw`(\d[\d,]*)\s+(?:[a-z-]+\s+){0,3}?${NOUN}\b`, 'i'),
    /\b(?:need|want|order|require|quantity(?:\s+(?:of|is))?|qty:?)\s+(?:of\s+|about\s+)?(\d[\d,]*)\b/i,
  ];
  for (const re of pats) {
    const m = t.match(re);
    if (m) return n(m[1]!);
  }
  if (beforePart) return n(beforePart[1]!);
  if (reply) {
    const all = t.match(/\d[\d,]*/g) ?? [];
    if (all.length === 1) return n(all[0]!);
  }
  return null;
}

function dateIn(text: string, today: string): string | null {
  const m = text.match(/\bby\s+(\d{1,2})\s+([A-Za-z]{3})[a-z]*\b/i) ?? text.match(/\bby\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2})\b/i);
  if (m) {
    const [d, mon] = /^\d/.test(m[1]!) ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
    const mi = MONTHS.indexOf(mon.toLowerCase());
    if (mi < 0) return null;
    let year = Number(today.slice(0, 4));
    const mk = (y: number) => `${y}-${String(mi + 1).padStart(2, '0')}-${d.padStart(2, '0')}`;
    if (mk(year) < today) year += 1;
    return mk(year);
  }
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return iso ? iso[1]! : null;
}

const none = <T>(value: T) => ({ value, cites: [] as string[] });

function intakeFields(facts: Fact[], rows: Fact[]) {
  const today = str(facts.find((f) => f.key === 'today'));
  const request = facts.filter((f) => f.key === 'request.segment');
  const lastReply = facts.filter((f) => /^reply\.\d+\.segment$/.test(f.key));
  const lastN = lastReply.length ? lastReply.at(-1)!.key : null;
  const latest = lastN ? lastReply.filter((f) => f.key === lastN) : [];
  const customer = [...request, ...lastReply];
  const lastQ = str(facts.filter((f) => f.key.startsWith('question.')).at(-1));
  // Latest answer first, so a reply overrides the request for the field it answers.
  const find = (pred: (t: string) => boolean): Fact | undefined => [...latest, ...request, ...lastReply].find((f) => pred(str(f)));
  const found = rows.map((r) => ({ id: r.id, partNumber: str(r).split(' | ')[0]!, description: str(r).split(' | ')[1] ?? '' }));

  let partNumber = none<string | null>(null);
  let partDescription = none<string | null>(null);
  const namedFact = find((t) => PART.test(t) && found.some((p) => p.partNumber === t.match(PART)![0]));
  if (namedFact) {
    const pn = str(namedFact).match(PART)![0];
    partNumber = { value: pn, cites: [found.find((p) => p.partNumber === pn)!.id, namedFact.id] };
  } else if (found.length === 1) {
    const by = find((t) => partQuery(t) !== null) ?? customer[0];
    if (by) partNumber = { value: found[0]!.partNumber, cites: [found[0]!.id, by.id] };
  } else if (found.length > 1 && latest.length) {
    // "the sealed one": a reply word that appears in exactly one option's description settles it
    for (const f of latest) {
      const words = str(f).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const hits = found.filter((p) => words.some((w) => p.description.toLowerCase().split(/[^a-z0-9]+/).includes(w)));
      if (hits.length === 1) {
        partNumber = { value: hits[0]!.partNumber, cites: [hits[0]!.id, f.id] };
        break;
      }
    }
  }
  if (partNumber.value === null) {
    const f = request.find((x) => partQuery(str(x)) !== null);
    if (f) partDescription = { value: partQuery(str(f))!.slice(0, 80), cites: [f.id] };
  }

  let quantity = none<number | null>(null);
  // The latest answer first (a reply overrides the request), then the request.
  for (const [list, reply] of [[latest, true], [request, false]] as const) {
    for (const f of list) {
      const q = quantityIn(str(f), reply);
      if (q !== null && q > 0) {
        quantity = { value: q, cites: [f.id] };
        break;
      }
    }
    if (quantity.value !== null) break;
  }

  const firmF = find((t) => /\bfirm\b/i.test(t));
  let price = none<number | null>(null);
  let reason = none<'competitor' | 'volume' | 'budget' | null>(null);
  for (const f of customer) {
    const t = str(f);
    const p = t.match(/(?:at|for|price of)\s*(?:₹|rs\.?\s*|inr\s*)(\d[\d,]*)/i) ?? t.match(/(?:₹|rs\.?\s*)(\d[\d,]*)\s*(?:each|per|\/)/i);
    // A price a rival is said to have offered ("rival quoted ₹850") is a claim, not an asked price.
    if (p && !/\b(rival|competitor|quoted|offer)/i.test(t.slice(0, p.index))) {
      price = { value: Number(p[1]!.replace(/,/g, '')), cites: [f.id] };
      break;
    }
  }
  if (price.value !== null) {
    const rs: [RegExp, 'competitor' | 'volume' | 'budget'][] = [
      [/competitor|lower offer|offered less|cheaper/i, 'competitor'],
      [/volume|bulk|large (order|quantity)/i, 'volume'],
      [/budget/i, 'budget'],
    ];
    for (const [re, v] of rs) {
      const f = find((t) => re.test(t));
      if (f) {
        reason = { value: v, cites: [f.id] };
        break;
      }
    }
  }
  let deliverBy = none<string | null>(null);
  const dateF = find((t) => dateIn(t, today) !== null);
  if (dateF) deliverBy = { value: dateIn(str(dateF), today), cites: [dateF.id, 'T1'] };
  let deliverTo = none<string | null>(null);
  for (const f of customer) {
    const to = str(f).match(/\b(?:to|in|at)\s+(Pune|Chennai|Ahmedabad|Mumbai|Delhi|Bengaluru|Hyderabad|Kolkata)\b/);
    if (to) {
      deliverTo = { value: to[1]!, cites: [f.id] };
      break;
    }
  }
  // "Please confirm this request is for <own account>" answered "yes": the request is for the caller.
  const confirmed = /confirm this request is for/i.test(lastQ) && latest.some((f) => /^\s*(yes|yep|yeah|ok|okay|confirm(ed)?|correct|right|that'?s right|sure)\b/i.test(str(f)));
  let account = none<string | null>(null);
  if (!confirmed) {
    for (const f of request) {
      const a = str(f).match(/\bfor\s+((?:[A-Z][a-z]+)(?:\s+[A-Z][a-z]+){0,3})\b/);
      if (a) {
        account = { value: a[1]!, cites: [f.id] };
        break;
      }
    }
  }
  return {
    account,
    partNumber,
    partDescription,
    quantity,
    firm: firmF ? { value: true, cites: [firmF.id] } : none(false),
    requestedUnitPrice: price,
    priceReason: price.value !== null ? reason : none(null),
    deliverBy,
    deliverTo,
  };
}

function intake(opts: LanguageModelV4CallOptions, prompt: string): LanguageModelV4GenerateResult {
  const facts = factsOf(opts);
  const toolMsgs = opts.prompt.filter((m) => m.role === 'tool');
  if (!toolMsgs.length) {
    const replies = facts.filter((f) => f.key.startsWith('reply.'));
    const named = replies.map((f) => str(f).match(PART)?.[0]).find(Boolean);
    const q = named ?? partQuery(facts.filter((f) => f.key === 'request.segment').map(str).join(' '));
    if (q) return result('', prompt, { name: 'lookupCatalogue', input: { query: q } });
  }
  const rows: Fact[] = [];
  for (const m of toolMsgs) {
    for (const part of m.content as { type: string; output?: { type: string; value: unknown } }[]) {
      if (part.type === 'tool-result' && part.output?.type === 'json' && Array.isArray(part.output.value)) rows.push(...(part.output.value as Fact[]));
    }
  }
  return result(JSON.stringify(intakeFields(facts, rows)), prompt);
}

// ---- Clarification ----

function clarify(opts: LanguageModelV4CallOptions, prompt: string): LanguageModelV4GenerateResult {
  const facts = factsOf(opts);
  const get = (key: string) => facts.find((f) => f.key === key);
  const reason = str(get('reason')) as ClarificationInput['reason'];
  if (!['part', 'account', 'quantity'].includes(reason)) return result(JSON.stringify({ question: null, cites: [] }), prompt);
  const rows = facts.filter((f) => f.key === 'catalogue.part');
  const input: ClarificationInput = {
    reason,
    ownAccountName: str(get('account.own')),
    quantity: (get('quantity')?.value as number | null) ?? null,
    options: rows.map((r) => ({ partNumber: str(r).split(' | ')[0]!, description: str(r).split(' | ')[1] ?? '' })),
  };
  const cites = ['F1', ...(reason === 'account' ? ['F2'] : []), ...rows.map((r) => r.id)];
  return result(JSON.stringify({ question: templateQuestion(input), cites }), prompt);
}

// ---- Claim evidence ----

function evidence(opts: LanguageModelV4CallOptions, prompt: string): LanguageModelV4GenerateResult {
  const facts = factsOf(opts);
  const item = str(facts.find((f) => f.key === 'rfq.itemCode'));
  const findings: { text: string; cites: string[]; quote: string }[] = [];
  for (const d of facts.filter((f) => f.key === 'attachment.segment')) {
    const pn = str(d).match(PART)?.[0];
    if (item && pn && pn !== item) findings.push({ text: `The document names part ${pn}, and the request is for ${item}.`, cites: [d.id, 'F1'], quote: pn });
    if (findings.length >= 3) break;
  }
  return result(JSON.stringify({ findings }), prompt);
}

// ---- Decline reader ----

function decline(opts: LanguageModelV4CallOptions, prompt: string): LanguageModelV4GenerateResult {
  const facts = factsOf(opts);
  const reply = facts.filter((f) => f.key === 'reply.segment');
  const all = reply.map(str).join(' ');
  const declines = /\b(declin\w*|cancel\w*|no longer|not proceed|go elsewhere|went with|another supplier|pass on this|no thanks|too late|can.?t wait|cannot wait|turn(ing)? (it|this) down)\b/i;
  const accepts = /\b(we accept|accepted|go ahead|please proceed|confirm(ed)? the order|agreed)\b/i;
  const reasons: [string, RegExp][] = [
    ['delivery_date', /\b(late|wait|date|delivery|sooner|by \d{1,2} \w+|lead time|too long)\b/i],
    ['competitor', /\b(competitor|another supplier|elsewhere|other vendor)\b/i],
    ['price', /\b(price|expensive|costly|cheaper|budget|too high)\b/i],
    ['specification', /\b(spec|specification|wrong part|different part|size)\b/i],
  ];
  const noReason = { value: null, cites: [] as string[], evidence: null };
  let out: { decision: { value: string; cites: string[] }; reason: { value: string | null; cites: string[]; evidence: string | null } } = { decision: { value: 'question', cites: [] }, reason: noReason };
  const dec = reply.find((f) => declines.test(str(f)));
  const acc = reply.find((f) => accepts.test(str(f)) || /^\s*(yes|ok|okay|accept(ed)?)\b/i.test(str(f)));
  if (dec) {
    out = { decision: { value: 'decline', cites: [dec.id] }, reason: noReason };
    for (const [reason, re] of reasons) {
      const f = reply.find((x) => re.test(str(x)));
      if (f) {
        out.reason = { value: reason, cites: [f.id], evidence: str(f).replace(/[.!?]+$/, '').slice(0, 200) };
        break;
      }
    }
  } else if (acc && all.length) out = { decision: { value: 'accept', cites: [acc.id] }, reason: noReason };
  return result(JSON.stringify(out), prompt);
}

// ---- Model ----

export function demoModel(modelId = 'demo'): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId,
    supportedUrls: {},
    async doGenerate(opts) {
      const prompt = JSON.stringify(opts.prompt);
      const system = textOf(opts.prompt.find((m) => m.role === 'system'));
      if (system === INTAKE_SYSTEM) return intake(opts, prompt);
      if (system === CLARIFICATION_SYSTEM) return clarify(opts, prompt);
      if (system === FINANCE_REFERRAL_SYSTEM) return result(JSON.stringify(templateFinanceCase(factsOf(opts))), prompt);
      if (system === DECLINE_READER_SYSTEM) return decline(opts, prompt);
      if (system === EVIDENCE_SYSTEM) return evidence(opts, prompt);
      throw new Error('demo model: unknown agent');
    },
    async doStream() {
      throw new Error('demo model: streaming is not used');
    },
  };
}
