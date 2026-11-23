import { BUDGET, COST_DEFAULTS } from './config';
import type { UsageView } from './contract';

/**
 * AI usage and cost (DESIGN.md section 13). Money in rupees. Model cost comes from a per-model price
 * table in rupees per million tokens (input and output blended); compute from the Temporal action
 * count. Everything is env-overridable so Finance can plug in the real contract rates.
 */

export type Stage = 'dev' | 'prerelease' | 'prod';

export interface CostConfig {
  stage: Stage;
  shipModel: string;
  openWeightModel: string;
  /** Exact model id → ₹ per million tokens. `provider:*` entries match any model of that provider. */
  prices: Record<string, number>;
  computeInrPerRfq: number;
  actionsPerRfq: number;
}

const numEnv = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);

const STAGES: readonly Stage[] = ['dev', 'prerelease', 'prod'];

export function costConfig(env: NodeJS.ProcessEnv = process.env): CostConfig {
  const raw = env.STAGE?.trim() ?? '';
  // A typo such as STAGE=production must not quietly run (and bill) the development model.
  if (raw !== '' && !(STAGES as readonly string[]).includes(raw)) throw new Error(`STAGE must be dev, prerelease or prod (got "${raw}")`);
  const stage: Stage = raw === '' ? 'dev' : (raw as Stage);
  const shipModel = env.SHIP_MODEL ?? COST_DEFAULTS.shipModel;
  const openWeightModel = env.OPEN_WEIGHT_MODEL ?? COST_DEFAULTS.openWeightModel;
  const ship = numEnv(env.AI_PRICE_SHIP_INR_PER_M, COST_DEFAULTS.shipInrPerMTokens);
  const open = numEnv(env.AI_PRICE_OPEN_INR_PER_M, COST_DEFAULTS.openWeightInrPerMTokens);
  const mock = numEnv(env.AI_PRICE_MOCK_INR_PER_M, COST_DEFAULTS.mockInrPerMTokens);
  const prices: Record<string, number> = { 'mock:*': mock, 'local:*': open, [openWeightModel]: open, 'openai:*': ship, [shipModel]: ship };
  if (env.AI_PRICE_TABLE) {
    try {
      const extra = JSON.parse(env.AI_PRICE_TABLE) as Record<string, unknown>;
      for (const [k, v] of Object.entries(extra)) if (typeof v === 'number' && v >= 0) prices[k] = v;
    } catch {
      throw new Error('AI_PRICE_TABLE must be JSON like {"openai:gpt-5-mini": 410}');
    }
  }
  return {
    stage,
    shipModel,
    openWeightModel,
    prices,
    computeInrPerRfq: numEnv(env.COMPUTE_INR_PER_RFQ, COST_DEFAULTS.computeInrPerRfq),
    actionsPerRfq: Math.max(1, numEnv(env.ACTIONS_PER_RFQ, COST_DEFAULTS.actionsPerRfq)),
  };
}

/** Default model id for the stage: development runs the open-weight model, pre-release and production the shipping model. */
export const stageModel = (c: CostConfig) => (c.stage === 'dev' ? c.openWeightModel : c.shipModel);

/** ₹ per million tokens. Unknown models are priced as the shipping model, so a gap never reads as free. */
export function pricePerM(c: CostConfig, model: string): number {
  if (model in c.prices) return c.prices[model]!;
  const provider = model.split(':')[0];
  const wild = c.prices[`${provider}:*`];
  return wild ?? c.prices[c.shipModel] ?? COST_DEFAULTS.shipInrPerMTokens;
}

export const paise = (inr: number) => Math.round(inr * 100) / 100;

/**
 * Cost of one call in ₹, unrounded: a 150-token call on the open-weight model costs ₹0.00375, and
 * rounding each call to the paisa before summing would report it as free. Round once, for display.
 * Reasoning tokens are billed as output and are already inside outputTokens.
 */
export function callCostInr(inputTokens: number, outputTokens: number, inrPerM: number): number {
  return ((inputTokens + outputTokens) * inrPerM) / 1_000_000;
}

/** Budget share: four decimals so a ₹0.20 cost on ₹36,000 of margin reads 0.0006%, not 0. */
const pct4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function computeCostInr(c: CostConfig, actions: number): number {
  return paise((actions / c.actionsPerRfq) * c.computeInrPerRfq);
}

export interface UsageTotals {
  calls: number;
  input: number;
  output: number;
  reasoning: number;
  aiInr: number;
}

/**
 * `t.aiInr` is the unrounded sum of the calls; money is rounded once here, to the paisa. `inrPerM` is
 * the rate of the model in force for the RFQ, so the token cap can be shown as a rupee budget.
 */
export function usageView(
  c: CostConfig,
  t: UsageTotals,
  actions: number,
  flags: { capped: boolean; smallOrder: boolean },
  grossMarginInr: number | null,
  inrPerM: number = pricePerM(c, stageModel(c)),
): UsageView {
  const computeExact = (actions / c.actionsPerRfq) * c.computeInrPerRfq;
  const totalExact = t.aiInr + computeExact;
  const aiInr = paise(t.aiInr);
  const computeInr = paise(computeExact);
  const totalInr = paise(totalExact);
  const budgetInr = paise((BUDGET.tokenCapPerRfq * inrPerM) / 1_000_000);
  return {
    calls: t.calls,
    tokens: { input: t.input, output: t.output, reasoning: t.reasoning, total: t.input + t.output },
    capTokens: BUDGET.tokenCapPerRfq,
    inrPerMTokens: inrPerM,
    budgetInr,
    budgetUsedPct: Math.min(100, pct4(((t.input + t.output) / BUDGET.tokenCapPerRfq) * 100)),
    capped: flags.capped,
    smallOrder: flags.smallOrder,
    aiInr,
    actions,
    computeInr,
    totalInr,
    grossMarginInr,
    pctOfMargin: grossMarginInr && grossMarginInr > 0 ? pct4((totalExact / grossMarginInr) * 100) : null,
  };
}

/** Cheapest of the given model ids by the price table (first wins a tie). */
export function cheapest(c: CostConfig, ids: string[]): string {
  return ids.reduce((best, id) => (pricePerM(c, id) < pricePerM(c, best) ? id : best), ids[0]!);
}
