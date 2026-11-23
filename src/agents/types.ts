import type { Fact } from './grounding';

/** Provenance for every agent step; written to the audit table and the workflow trace. */
export interface AgentMeta {
  actor: string; // agent name
  model: string; // provider:model id
  promptVersion: string;
  fallback?: boolean; // true when code replaced an unusable model output
  problem?: string; // which check failed, when fallback is true (verdict.reason)
  cites?: Record<string, string[]>; // output field -> fact ids, after verification
  facts?: Fact[]; // the fact list of this call (ids resolve against it); internal roles only
  promptLeak?: string; // what leaked (canary, prompt words, schema word): audit row says "prompt-leak attempt"
}

/** Tokens one call used, straight from the AI SDK's totalUsage (all steps of a tool loop). */
export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export const NO_USAGE: CallUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };

export interface AgentResult<T> {
  output: T;
  meta: AgentMeta;
  usage: CallUsage;
}

/** Called once per model call, success or failure, so the cost of failed tries is counted too. */
export type UsageSink = (u: CallUsage, ok: boolean) => void;
