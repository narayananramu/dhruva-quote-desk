import { z } from 'zod';
import type { AgentInfo } from '../contract';
import { AGENT_PROMPTS, type AgentId } from './prompts';

/** The AgentInfo that GET /agents (staff only) returns, built from the constants the agent actually runs with. */
export function agentInfo(id: AgentId, model: string | null, schema: z.ZodType, tools: { name: string; description: string }[]): AgentInfo {
  const p = AGENT_PROMPTS[id];
  return {
    id,
    name: p.name,
    job: p.job,
    actor: p.actor,
    promptVersion: p.promptVersion,
    file: p.file,
    model,
    temperature: 0,
    tools,
    sees: p.sees,
    returns: p.returns,
    onFailure: p.onFailure,
    cites: p.cites,
    abstains: p.abstains,
    systemPrompt: p.system,
    userTemplate: p.userTemplate,
    outputSchema: z.toJSONSchema(schema),
  };
}
