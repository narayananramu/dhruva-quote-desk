import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createProviderRegistry, type LanguageModel } from 'ai';
import { demoModel } from './agents/demo-model';
import { cheapest, costConfig, stageModel } from './usage';

export interface AgentModels {
  intake: LanguageModel;
  clarification: LanguageModel;
  financeReferral: LanguageModel;
  declineReader: LanguageModel;
  /** Optional claim evidence reader (fake rival documents). Adds cited reasons only. */
  evidence: LanguageModel;
  /** Intake on the small-order path (section 13): the cheapest configured model. */
  smallOrderIntake: LanguageModel;
}

export type ModelIds = Record<keyof AgentModels, string>;

/**
 * Model ids chosen by env. STAGE (dev | prerelease | prod) picks the default: development runs the
 * open-weight model, pre-release and production the shipping model. QUOTE_MODEL overrides the
 * default; INTAKE_MODEL, CLARIFY_MODEL, FINANCE_MODEL (PRICING_MODEL still read) and DECLINE_MODEL
 * override per agent (EVIDENCE_MODEL for the claim evidence reader); SMALL_ORDER_MODEL overrides the cheap-path pick. Ids look like:
 *   openai:gpt-5-mini   (needs OPENAI_API_KEY)
 *   local:qwen3:8b      (OpenAI-compatible server at LOCAL_BASE_URL, e.g. Ollama)
 *   mock                (deterministic demo model, no key)
 */
export function modelIdsFromEnv(env: NodeJS.ProcessEnv = process.env): ModelIds {
  const def = env.QUOTE_MODEL ?? stageModel(costConfig(env));
  const ids = {
    intake: env.INTAKE_MODEL ?? def,
    clarification: env.CLARIFY_MODEL ?? def,
    financeReferral: env.FINANCE_MODEL ?? env.PRICING_MODEL ?? def,
    declineReader: env.DECLINE_MODEL ?? def,
    evidence: env.EVIDENCE_MODEL ?? def,
  };
  const normal = (id: string) => (id === 'mock' ? 'mock:demo' : id);
  const configured = [...new Set([ids.intake, ids.clarification, ids.financeReferral, ids.declineReader, env.CHEAP_MODEL].filter((x): x is string => !!x).map(normal))];
  return {
    intake: normal(ids.intake),
    clarification: normal(ids.clarification),
    financeReferral: normal(ids.financeReferral),
    declineReader: normal(ids.declineReader),
    evidence: normal(ids.evidence),
    smallOrderIntake: normal(env.SMALL_ORDER_MODEL ?? cheapest(costConfig(env), configured)),
  };
}

export function modelsFromEnv(env: NodeJS.ProcessEnv = process.env): AgentModels {
  const ids = modelIdsFromEnv(env);
  const registry = createProviderRegistry({
    openai: createOpenAI({ apiKey: env.OPENAI_API_KEY }),
    local: createOpenAICompatible({
      name: 'local',
      baseURL: env.LOCAL_BASE_URL ?? 'http://localhost:11434/v1',
      apiKey: env.LOCAL_API_KEY,
      supportsStructuredOutputs: true,
    }),
  });
  const pick = (id: string): LanguageModel =>
    id.startsWith('mock:') ? demoModel(id.slice(5)) : registry.languageModel(id as `openai:${string}` | `local:${string}`);
  return {
    intake: pick(ids.intake),
    clarification: pick(ids.clarification),
    financeReferral: pick(ids.financeReferral),
    declineReader: pick(ids.declineReader),
    evidence: pick(ids.evidence),
    smallOrderIntake: pick(ids.smallOrderIntake),
  };
}

/**
 * The configured id of a model ("local:qwen3:8b"), used for the price table and the audit. Providers
 * report a sub-API in their name ("local.chat", "openai.responses"); only the part before the dot is
 * the registry prefix.
 */
export function modelLabel(model: LanguageModel): string {
  return typeof model === 'string' ? model : `${model.provider.split('.')[0]}:${model.modelId}`;
}
