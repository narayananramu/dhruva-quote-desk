import type { LanguageModel } from 'ai';
import type { FinanceFacts } from '../domain';
import { modelLabel } from '../models';
import { agentInfo } from './describe';
import { factsMessage, financeFactList, templateFinanceCase, verifyFinance, type Claim, type ClaimFactInput, type Fact, type FinanceCited } from './grounding';
import { AGENT_PROMPTS, FINANCE_REFERRAL_PROMPT_VERSION, FINANCE_REFERRAL_SYSTEM } from './prompts';
import { callAgent } from './run';
import { referralOutputSchema } from './schemas';
import { NO_USAGE, type AgentResult, type UsageSink } from './types';

export { referralOutputSchema };
export const FINANCE_REFERRAL = { actor: AGENT_PROMPTS.finance.actor, promptVersion: FINANCE_REFERRAL_PROMPT_VERSION } as const;

/** The stored case: facts from code, and cited statements (from the model when they verify, else from code). */
export interface FinanceReferral {
  facts: FinanceFacts; // from code, never from the model
  factList: Fact[]; // what the model saw, so the UI can resolve a cite and Finance can cite its reason
  dataStatus: 'sufficient' | 'insufficient';
  missing: string[];
  summary: Claim[];
  considerations: Claim[];
}

export const referralFrom = (facts: FinanceFacts, factList: Fact[], c: FinanceCited): FinanceReferral => ({ facts, factList, dataStatus: c.dataStatus, missing: c.missing, summary: c.summary, considerations: c.considerations });

export async function runFinanceReferralAgent(model: LanguageModel, facts: FinanceFacts, claims: ClaimFactInput[], sink?: UsageSink, maxOutputTokens?: number): Promise<AgentResult<FinanceReferral>> {
  const factList = financeFactList(facts, claims);
  const meta = { ...FINANCE_REFERRAL, model: modelLabel(model), facts: factList };
  let usage = NO_USAGE;
  let problem = 'MODEL_ERROR';
  let promptLeak: string | undefined;
  try {
    const r = await callAgent({ model, system: FINANCE_REFERRAL_SYSTEM, input: factsMessage(factList), schema: referralOutputSchema, sink, maxOutputTokens });
    usage = r.usage;
    const v = verifyFinance(r.output, factList);
    if (v.ok) {
      const cites = Object.fromEntries([...r.output.summary.map((c, i) => [`summary[${i}]`, c.cites]), ...r.output.considerations.map((c, i) => [`considerations[${i}]`, c.cites])]);
      return { output: referralFrom(facts, factList, r.output), meta: { ...meta, cites }, usage };
    }
    problem = v.reason ?? 'ungrounded';
    promptLeak = v.failures.find((f) => f.code === 'PROMPT_LEAK')?.detail;
  } catch {
    // fall through: code writes the case from the facts
  }
  return { output: referralFrom(facts, factList, templateFinanceCase(factList)), meta: { ...meta, fallback: true, problem, ...(promptLeak && { promptLeak }) }, usage };
}

export const describe = (model: string | null) => agentInfo('finance', model, referralOutputSchema, []);
