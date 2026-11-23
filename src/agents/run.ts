import { generateText, Output, type LanguageModel, type LanguageModelUsage, type StopCondition, type ToolSet } from 'ai';
import type { z } from 'zod';
import { NO_USAGE, type CallUsage, type UsageSink } from './types';

export function toCallUsage(u: LanguageModelUsage | undefined): CallUsage {
  if (!u) return NO_USAGE;
  return { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? 0 };
}

/**
 * One agent call: system prompt, one JSON user message, schema-checked output, temperature 0.
 * Reports usage to `sink` whether the call succeeds or not; throws on failure.
 */
export async function callAgent<S extends z.ZodType>(opts: {
  model: LanguageModel;
  system: string;
  input: object;
  schema: S;
  tools?: ToolSet;
  stopWhen?: StopCondition<ToolSet>;
  sink?: UsageSink;
  /** Per step; set by the activity to what is left of the RFQ's token budget (section 13). */
  maxOutputTokens?: number;
}): Promise<{ output: z.infer<S>; usage: CallUsage }> {
  let usage: CallUsage | null = null;
  try {
    const r = await generateText({
      model: opts.model,
      system: opts.system,
      prompt: JSON.stringify(opts.input),
      output: Output.object({ schema: opts.schema }),
      temperature: 0,
      ...(opts.maxOutputTokens !== undefined && { maxOutputTokens: opts.maxOutputTokens }),
      ...(opts.tools && { tools: opts.tools }),
      ...(opts.stopWhen && { stopWhen: opts.stopWhen }),
    });
    usage = toCallUsage(r.totalUsage);
    const output = opts.schema.parse(r.output) as z.infer<S>;
    opts.sink?.(usage, true);
    return { output, usage };
  } catch (e) {
    opts.sink?.(usage ?? toCallUsage((e as { usage?: LanguageModelUsage }).usage), false);
    throw e;
  }
}
