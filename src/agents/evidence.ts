import type { LanguageModel } from 'ai';
import { modelLabel } from '../models';
import { agentInfo } from './describe';
import { evidenceFacts, factsMessage, groundEvidence, type EvidenceInput, type Finding } from './grounding';
import { AGENT_PROMPTS, EVIDENCE_PROMPT_VERSION, EVIDENCE_SYSTEM } from './prompts';
import { callAgent } from './run';
import { evidenceOutputSchema } from './schemas';
import { NO_USAGE, type AgentResult, type UsageSink } from './types';

export { evidenceOutputSchema, type EvidenceInput };
export const EVIDENCE = { actor: AGENT_PROMPTS.evidence.actor, promptVersion: EVIDENCE_PROMPT_VERSION } as const;

/**
 * Optional: reads a buyer's rival document and returns cited mismatches. It never decides: no level,
 * score or verdict field; code drops every finding that fails the verifier, and on any error the
 * alert stands on the code signals alone (empty findings).
 */
export async function runEvidenceAgent(model: LanguageModel, input: EvidenceInput, sink?: UsageSink, maxOutputTokens?: number): Promise<AgentResult<{ findings: Finding[]; dropped: number }>> {
  const facts = evidenceFacts(input);
  const meta = { ...EVIDENCE, model: modelLabel(model), facts };
  try {
    const r = await callAgent({ model, system: EVIDENCE_SYSTEM, input: factsMessage(facts), schema: evidenceOutputSchema, sink, maxOutputTokens });
    const g = groundEvidence(r.output.findings, facts);
    return {
      output: { findings: g.kept, dropped: g.dropped.length },
      meta: { ...meta, cites: Object.fromEntries(g.kept.map((f, i) => [`findings[${i}]`, f.cites])), ...(g.dropped.length && { problem: g.dropped.map((d) => d.reason).join('; ') }) },
      usage: r.usage,
    };
  } catch {
    return { output: { findings: [], dropped: 0 }, meta: { ...meta, fallback: true, problem: 'MODEL_ERROR' }, usage: NO_USAGE };
  }
}

export const describe = (model: string | null) => agentInfo('evidence', model, evidenceOutputSchema, []);
