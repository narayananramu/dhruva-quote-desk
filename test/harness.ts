import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, DefaultLogger, makeTelemetryFilterString, Runtime, Worker, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import type { WorkflowHandle } from '@temporalio/client';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createActivities, type Activities } from '../src/activities';
import { createApi, type Api } from '../src/api';
import { demoModel } from '../src/agents/demo-model';
import { numbersIn, type Fact } from '../src/agents/grounding';
import type { QuoteDetail } from '../src/contract';
import type { AgentModels } from '../src/models';
import type { QuoteInput, QuoteState } from '../src/state';
import { Store } from '../src/store';
import { costConfig, type CostConfig } from '../src/usage';
import { quoteWorkflow, stateQuery } from '../src/workflows';

// ---- Deterministic mock models (real AI SDK code path, no API keys) ----

export const usageOf = (input = 10, output = 10, reasoning = 0) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output - reasoning, reasoning },
});

export function jsonResult(obj: object, u = usageOf()): LanguageModelV4GenerateResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], finishReason: { unified: 'stop', raw: 'stop' }, usage: u, warnings: [] };
}

export function toolCallResult(toolName: string, input: object, u = usageOf()): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId: `call-${Math.random().toString(36).slice(2, 8)}`, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: u,
    warnings: [],
  };
}

/** A mock that records every prompt it receives so tests can assert what an agent was (not) shown. */
export function mockModel(modelId: string, respond: (prompt: string, opts: LanguageModelV4CallOptions) => LanguageModelV4GenerateResult | Promise<LanguageModelV4GenerateResult>) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId,
    doGenerate: async (opts) => {
      prompts.push(JSON.stringify(opts.prompt.filter((m) => m.role !== 'system')));
      return respond(JSON.stringify(opts.prompt), opts);
    },
  });
  return { model, prompts };
}

/** The user message of the first call, parsed. */
export const userJson = (opts: LanguageModelV4CallOptions) => JSON.parse((opts.prompt.find((m) => m.role === 'user')!.content as { text: string }[])[0]!.text);

export const fields = (over: object = {}) => ({
  account: null,
  partNumber: null,
  partDescription: null,
  quantity: null,
  firm: true,
  requestedUnitPrice: null,
  priceReason: null,
  deliverBy: null,
  deliverTo: null,
  ...over,
});

/** The cited intake output: every field as {value, cites}. `cites` maps a field to its fact ids. */
export const citedFields = (over: object = {}, cites: Record<string, string[]> = {}) =>
  Object.fromEntries(Object.entries(fields(over)).map(([k, v]) => [k, { value: v, cites: cites[k] ?? [] }]));

/**
 * A scripted intake model that behaves like a well-formed but possibly fooled LLM: it looks up the
 * part it was told to return, then returns `over` with each value citing the customer sentence that
 * holds it (or R1 when none does, so the verifier drops a made-up value). Extra keys pass through.
 */
export function intakeReply(over: Record<string, unknown>, u = usageOf()) {
  return (_p: string, opts: LanguageModelV4CallOptions): LanguageModelV4GenerateResult => {
    const tools = opts.prompt.filter((m) => m.role === 'tool');
    if (!tools.length && typeof over.partNumber === 'string') return toolCallResult('lookupCatalogue', { query: over.partNumber }, u);
    const facts = (userJson(opts) as { facts: Fact[] }).facts;
    const rows = tools.flatMap((m) => (m.content as { output?: { value: unknown } }[]).flatMap((c) => (Array.isArray(c.output?.value) ? (c.output!.value as Fact[]) : [])));
    const said = facts.filter((f) => f.key.startsWith('request.') || f.key.startsWith('reply.'));
    const holding = (v: unknown) =>
      said.find((f) => (typeof v === 'number' ? numbersIn(String(f.value)).includes(v) : String(f.value).includes(String(v))))?.id ?? said[0]?.id ?? 'R1';
    const base = fields(over);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(over)) if (!(k in base)) out[k] = v;
    for (const [k, v] of Object.entries(base)) {
      if (v === null || (v as unknown) === false) out[k] = { value: v, cites: [] };
      else if (k === 'partNumber') out[k] = { value: v, cites: [...rows.filter((r) => String(r.value).split(' | ')[0] === String(v)).map((r) => r.id), holding(v)] };
      else if (k === 'firm' || k === 'priceReason') out[k] = { value: v, cites: [said[0]?.id ?? 'R1'] };
      else out[k] = { value: v, cites: [holding(v)] };
    }
    return jsonResult(out, u);
  };
}

/** A decline-reader output in the cited shape. */
export const declineOut = (decision: string, cite: string | null, reason: string | null = null, evidence: string | null = null, reasonCite: string | null = cite) => ({
  decision: { value: decision, cites: cite ? [cite] : [] },
  reason: { value: reason, cites: reason && reasonCite ? [reasonCite] : [], evidence },
});

/** Demo models for every agent unless a test overrides one. */
export function defaultModels(over: Partial<AgentModels> = {}): AgentModels {
  return {
    intake: demoModel('intake'),
    clarification: demoModel('clarify'),
    financeReferral: demoModel('finance'),
    declineReader: demoModel('decline'),
    evidence: demoModel('evidence'),
    smallOrderIntake: demoModel('small'),
    ...over,
  };
}

// ---- Temporal test environment with time skipping ----

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;
let n = 0;

export async function setupEnv(): Promise<void> {
  Runtime.install({ logger: new DefaultLogger('WARN'), telemetryOptions: { logging: { filter: makeTelemetryFilterString({ core: 'ERROR' }) } } });
  env = await TestWorkflowEnvironment.createTimeSkipping();
  bundle = await bundleWorkflowCode({ logger: new DefaultLogger('WARN'), workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)) });
}

export async function teardownEnv(): Promise<void> {
  await env?.teardown();
}

export interface Ctx {
  env: TestWorkflowEnvironment;
  store: Store;
  activities: Activities;
  costs: CostConfig;
  taskQueue: string;
  /** Unique RFQ id for this test (the Temporal env is shared across tests). */
  id(name: string): string;
  now(): number;
  /** Skip time on the test server and keep the API clock in step. */
  skip(ms: number): Promise<void>;
  start(input: Partial<QuoteInput> & { rfqId: string; account: string }): Promise<WorkflowHandle<typeof quoteWorkflow>>;
  waitFor(h: WorkflowHandle<typeof quoteWorkflow>, pred: (s: QuoteState) => boolean, what?: string): Promise<QuoteState>;
  api(user: string, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }>;
  apiObj(): Api;
  detail(rfqId: string): Promise<QuoteDetail>;
}

export interface WorkerOpts {
  models?: Partial<AgentModels>;
  costEnv?: NodeJS.ProcessEnv;
}

/** Fresh seeded store, models and worker for one test. */
export async function withWorker(opts: WorkerOpts, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const k = ++n;
  const taskQueue = `test-${k}`;
  const store = new Store(':memory:');
  let base = await env.currentTimeMs();
  let real = Date.now();
  const clock = () => base + (Date.now() - real);
  store.seedBase(clock());
  const costs = costConfig(opts.costEnv ?? {});
  const activities = createActivities({ store, models: defaultModels(opts.models), costs });
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle, activities });
  let server: Server | undefined;
  const api = createApi({ client: env.client, store, taskQueue, clock, costs, modelIds: null, settleMs: 5000, stage: 'test' });
  const started: string[] = [];

  const ctx: Ctx = {
    env,
    store,
    activities,
    costs,
    taskQueue,
    id: (name) => `RFQ-T${k}-${name}`,
    now: clock,
    async skip(ms) {
      await env.sleep(ms);
      base = await env.currentTimeMs();
      real = Date.now();
    },
    async start(input) {
      const full: QuoteInput = { quoteRef: `Q-T${k}-${input.rfqId}`, channel: 'mail', receivedAt: clock(), clockOffsetMs: 0, ...input, workflowId: input.rfqId.toLowerCase() };
      store.insertRfq({ rfqId: full.rfqId, workflowId: full.workflowId!, quoteRef: full.quoteRef, account: full.account, channel: full.channel, receivedAt: full.receivedAt });
      started.push(full.workflowId!);
      return env.client.workflow.start(quoteWorkflow, { taskQueue, workflowId: full.workflowId!, args: [full] });
    },
    async waitFor(h, pred, what = 'condition') {
      let last: QuoteState | undefined;
      for (let i = 0; i < 300; i++) {
        last = await h.query(stateQuery);
        if (pred(last)) {
          await new Promise((r) => setTimeout(r, 30)); // let the publish activity land
          return h.query(stateQuery);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timed out waiting for ${what}; last status ${last?.status}/${last?.salesNeed}`);
    },
    async api(user, method, path, body, headers = {}) {
      if (!server) {
        server = createServer(api);
        await new Promise<void>((r) => server!.listen(0, r));
      }
      const { port } = server.address() as AddressInfo;
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { ...(user && { 'x-demo-user': user }), 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
    },
    apiObj: () => api,
    async detail(rfqId) {
      return (await ctx.api('sales', 'GET', `/quotes/${rfqId}`)).body.quote as QuoteDetail;
    },
  };
  try {
    await worker.runUntil(fn(ctx));
  } finally {
    server?.close();
    // Terminate this test's still-running workflows (open timers on a dead task queue would stall time skipping).
    const ids = [...started, ...store.rfqs().map((r) => r.workflowId)];
    await Promise.all([...new Set(ids)].map((wid) => env.client.workflow.getHandle(wid).terminate('test finished').catch(() => undefined)));
  }
}

/** Waits for the API's derived stage. */
export async function waitStage(ctx: Ctx, rfqId: string, stage: string | ((d: QuoteDetail) => boolean)): Promise<QuoteDetail> {
  let last: QuoteDetail | undefined;
  for (let i = 0; i < 300; i++) {
    last = await ctx.detail(rfqId);
    if (typeof stage === 'string' ? last.stage === stage : stage(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${String(stage)}; last stage ${last?.stage}`);
}

/** Customer-facing leak pattern (7.4): bare cost figures, internal words, other accounts' names. */
export function leakPattern(account: string): RegExp {
  const names = { 'ACC-104': 'Acme Pumps', 'ACC-318': 'Kaveri Engineering', 'ACC-211': 'Shakti Motors' } as Record<string, string>;
  const others = Object.entries(names)
    .filter(([k]) => k !== account)
    .map(([, v]) => v);
  return new RegExp(`\\b(820|738|984|1200|205|328)\\b|margin|cost|profit|floor|max discount|minimum price|${others.join('|')}`, 'i');
}

export const settledStatus = (s: QuoteState) => !['intake', 'checking', 'sending'].includes(s.status);
