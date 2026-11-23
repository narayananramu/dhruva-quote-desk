import type { LanguageModel } from 'ai';
import { modelLabel } from '../models';
import { agentInfo } from './describe';
import { declineFacts, factsMessage, groundDecline, promptLeak, type DeclineCited, type DeclineInput } from './grounding';
import { gateDecision, type DeclineOutput } from './guardrails';
import { AGENT_PROMPTS, DECLINE_READER_PROMPT_VERSION, DECLINE_READER_SYSTEM } from './prompts';
import { callAgent } from './run';
import { declineOutputSchema } from './schemas';
import type { AgentResult, UsageSink } from './types';

export { declineOutputSchema, type DeclineInput };
export const DECLINE_READER = { actor: AGENT_PROMPTS.decline.actor, promptVersion: DECLINE_READER_PROMPT_VERSION } as const;

/** Throws on failure (Temporal retries); the workflow falls back to `question` after the last try. */
export async function runDeclineReader(model: LanguageModel, input: DeclineInput, sink?: UsageSink, maxOutputTokens?: number): Promise<AgentResult<DeclineOutput>> {
  const facts = declineFacts(input);
  const { output, usage } = await callAgent({ model, system: DECLINE_READER_SYSTEM, input: factsMessage(facts), schema: declineOutputSchema, sink, maxOutputTokens });
  const g = groundDecline(output as DeclineCited, facts);
  const leak = g.output.evidence ? promptLeak(g.output.evidence, false) : null;
  const grounded = leak ? { ...g.output, reason: null, evidence: null } : g.output;
  const gated = gateDecision(grounded, input.reply);
  const raw = output as DeclineCited;
  const changed = gated.decision !== raw.decision.value || gated.reason !== raw.reason.value || gated.evidence !== raw.reason.evidence;
  const problem = [!g.verdict.ok ? g.verdict.reason : null, changed ? 'gated' : null, leak ? `PROMPT_LEAK ${leak}` : null].filter(Boolean).join('; ');
  return {
    output: gated,
    usage,
    meta: { ...DECLINE_READER, model: modelLabel(model), cites: g.cites, facts, ...(problem && { problem }), ...(leak && { promptLeak: leak }) },
  };
}

export const describe = (model: string | null) => agentInfo('decline', model, declineOutputSchema, []);
