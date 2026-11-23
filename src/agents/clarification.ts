import type { LanguageModel } from 'ai';
import { modelLabel } from '../models';
import { agentInfo } from './describe';
import { clarifyFacts, factsMessage, verifyClarify, type ClarificationInput } from './grounding';
import { leaksInQuestion, templateQuestion } from './guardrails';
import { AGENT_PROMPTS, CLARIFICATION_PROMPT_VERSION, CLARIFICATION_SYSTEM } from './prompts';
import { callAgent } from './run';
import { clarificationOutputSchema } from './schemas';
import { NO_USAGE, type AgentResult, type UsageSink } from './types';

export { clarificationOutputSchema, templateQuestion, type ClarificationInput };
export const CLARIFICATION = { actor: AGENT_PROMPTS.clarify.actor, promptVersion: CLARIFICATION_PROMPT_VERSION } as const;

/**
 * Everything this agent sees is its fact list: the reason, the caller's own account name, catalogue
 * options and the quantity. No customer text, price, cost, stock or other account. No tools. Its
 * question is the only model text a customer can see, so it runs the verifier (cites, numbers,
 * names, writing lint, prompt leak) and then the leak checks; any failure sends the template.
 */
export async function runClarificationAgent(model: LanguageModel, input: ClarificationInput, otherAccountNames: string[], sink?: UsageSink, maxOutputTokens?: number): Promise<AgentResult<{ question: string }>> {
  const facts = clarifyFacts(input);
  const meta = { ...CLARIFICATION, model: modelLabel(model), facts };
  let usage = NO_USAGE;
  let problem = 'MODEL_ERROR';
  let promptLeak: string | undefined;
  try {
    const r = await callAgent({ model, system: CLARIFICATION_SYSTEM, input: factsMessage(facts), schema: clarificationOutputSchema, sink, maxOutputTokens });
    usage = r.usage;
    const v = verifyClarify(r.output, facts);
    const leak = v.ok && r.output.question !== null ? leaksInQuestion(r.output.question, input, otherAccountNames) : null;
    if (v.ok && !leak && r.output.question !== null) return { output: { question: r.output.question.trim() }, meta: { ...meta, cites: { question: r.output.cites } }, usage };
    problem = v.ok ? leak! : (v.reason ?? 'ungrounded');
    const pl = v.failures.find((f) => f.code === 'PROMPT_LEAK');
    if (pl) promptLeak = pl.detail;
  } catch {
    // fall through to the template; the workflow still asks a valid question
  }
  return { output: { question: templateQuestion(input) }, meta: { ...meta, fallback: true, problem, ...(promptLeak && { promptLeak }) }, usage };
}

export const describe = (model: string | null) => agentInfo('clarify', model, clarificationOutputSchema, []);
