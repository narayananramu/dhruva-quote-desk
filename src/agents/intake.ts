import { stepCountIs, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { Part, RfqRequest } from '../domain';
import { modelLabel } from '../models';
import { agentInfo } from './describe';
import { catalogueFact, factsMessage, groundIntake, intakeFacts, promptLeak, type Fact, type IntakeCited, type IntakeInput } from './grounding';
import { checkIntake } from './guardrails';
import { AGENT_PROMPTS, INTAKE_PROMPT_VERSION, INTAKE_SYSTEM, PROMPT_LIMITS } from './prompts';
import { callAgent } from './run';
import { intakeOutputSchema } from './schemas';
import type { AgentResult, UsageSink } from './types';

export const INTAKE = { actor: AGENT_PROMPTS.intake.actor, promptVersion: INTAKE_PROMPT_VERSION } as const;
export { intakeOutputSchema, type IntakeInput };

const TOOL_DESCRIPTION = 'Look up catalogue parts by part number or description words. Read-only. Returns catalogue facts: id and "PARTNUMBER | description".';

/**
 * Read-only tool: part numbers and descriptions only, at most 5 rows per lookup, as C facts. `rows`
 * collects every row returned during one call, so ids do not repeat across lookups and the verifier
 * can resolve them.
 */
export function catalogueTool(findParts: (query: string) => Part[], rows: Fact[] = []) {
  return tool({
    description: TOOL_DESCRIPTION,
    inputSchema: z.object({ query: z.string().max(80) }),
    execute: async ({ query }) =>
      findParts(query)
        .slice(0, PROMPT_LIMITS.catalogueResults)
        .map((p) => {
          const known = rows.find((r) => String(r.value).startsWith(`${p.partNumber} | `));
          if (known) return known;
          const f = catalogueFact(rows.length + 1, p);
          rows.push(f);
          return f;
        }),
  });
}

const STRING_FIELDS = ['account', 'partDescription', 'deliverTo'] as const;

export async function runIntakeAgent(
  model: LanguageModel,
  input: IntakeInput,
  deps: { findParts: (query: string) => Part[]; exactPart: (pn: string) => string | null },
  sink?: UsageSink,
  maxOutputTokens?: number,
): Promise<AgentResult<RfqRequest>> {
  const facts = intakeFacts(input);
  const rows: Fact[] = [];
  const { output, usage } = await callAgent({
    model,
    system: INTAKE_SYSTEM,
    input: factsMessage(facts),
    schema: intakeOutputSchema,
    tools: { lookupCatalogue: catalogueTool(deps.findParts, rows) },
    stopWhen: stepCountIs(PROMPT_LIMITS.catalogueLookups + 1),
    sink,
    maxOutputTokens,
  });
  const all = [...facts, ...rows];
  const g = groundIntake(output as IntakeCited, all);
  // A field that repeats a prompt canary or a run of prompt words is dropped like an uncited one.
  let leak: string | undefined;
  for (const f of STRING_FIELDS) {
    const v = g.fields[f];
    const hit = v ? promptLeak(v, false) : null;
    if (hit) {
      leak = hit;
      g.fields[f] = null;
      g.dropped.push(f);
    }
  }
  const { fields, changed } = checkIntake(g.fields, { today: input.today, exactPart: deps.exactPart });
  const problems = [...(g.verdict.ok ? [] : [g.verdict.reason ?? 'ungrounded']), ...(changed.length ? [`post-check: ${changed.join(', ')}`] : []), ...(leak ? [`PROMPT_LEAK ${leak}`] : [])];
  return {
    output: fields,
    usage,
    meta: { ...INTAKE, model: modelLabel(model), cites: g.cites, facts: all, ...(problems.length && { problem: problems.join('; ') }), ...(leak && { promptLeak: leak }) },
  };
}

export const describe = (model: string | null) => agentInfo('intake', model, intakeOutputSchema, [{ name: 'lookupCatalogue', description: TOOL_DESCRIPTION }]);
