import { z } from 'zod';
import { FACT_ID } from './grounding';
import { LOSS_REASONS, PRICE_REASONS, PROMPT_LIMITS, REPLY_DECISIONS } from './prompts';

/** Output schemas: every value carries the fact ids it rests on (docs/DESIGN.md 7.1). */
export const factId = z.string().regex(FACT_ID);
export const cites = z.array(factId).max(PROMPT_LIMITS.citesPerItem);
export const cited = <T extends z.ZodType>(value: T) => z.object({ value, cites });

export const intakeOutputSchema = z.object({
  account: cited(z.string().max(120).nullable()),
  partNumber: cited(z.string().max(40).nullable()),
  partDescription: cited(z.string().max(80).nullable()),
  quantity: cited(z.number().int().nullable()),
  firm: cited(z.boolean()),
  requestedUnitPrice: cited(z.number().nullable()),
  priceReason: cited(z.enum(PRICE_REASONS).nullable()),
  deliverBy: cited(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()),
  deliverTo: cited(z.string().max(60).nullable()),
});

export const clarificationOutputSchema = z.object({
  question: z.string().min(5).max(500).nullable(), // null = insufficient data, code sends the template
  cites,
});

const claim = z.object({ text: z.string().min(1).max(240), cites: cites.min(1) });
export const referralOutputSchema = z.object({
  dataStatus: z.enum(['sufficient', 'insufficient']),
  missing: z.array(factId).max(8),
  summary: z.array(claim).min(3).max(5),
  considerations: z.array(claim).max(5),
});

export const declineOutputSchema = z.object({
  decision: cited(z.enum(REPLY_DECISIONS)),
  reason: z.object({ value: z.enum(LOSS_REASONS).nullable(), cites, evidence: z.string().max(200).nullable() }),
});

export const evidenceOutputSchema = z.object({
  findings: z.array(z.object({ text: z.string().min(1).max(240), cites: cites.min(1), quote: z.string().max(200) })).max(PROMPT_LIMITS.evidenceFindings),
});
