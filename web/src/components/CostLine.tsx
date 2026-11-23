import type { UsageView } from '@/api/contract';
import { money, num, paise } from '@/lib/format';

/** Rupees to the paisa; a model cost that rounds to nothing but was not free reads "under ₹0.01". */
const aiText = (u: UsageView) => (u.aiInr === 0 && u.tokens.total > 0 && u.inrPerMTokens > 0 ? 'under ₹0.01' : paise(u.aiInr));
const pctText = (n: number) => (n > 0 && n < 0.01 ? 'under 0.01%' : `${n.toFixed(2)}%`);

/** Section 13: what this request cost to run, against its margin and its AI budget, in rupees. */
export function CostText({ u }: { u: UsageView }) {
  return (
    <>
      <b>{paise(u.totalInr)}</b> (AI {aiText(u)}, {num(u.tokens.total)} tokens · compute {paise(u.computeInr)})
      {u.pctOfMargin != null && u.grossMarginInr ? ` · ${pctText(u.pctOfMargin)} of ${money(u.grossMarginInr)} profit` : ''}
    </>
  );
}

/** The budget figure alone; the caller supplies the "AI budget" label. */
export function BudgetText({ u }: { u: UsageView }) {
  if (u.capped) return <span className="badge bad">{paise(u.budgetInr)} used up</span>;
  if (u.budgetInr === 0) return <>free model</>;
  return <>{aiText(u)} of {paise(u.budgetInr)} used</>;
}

export function CostLine({ u }: { u: UsageView }) {
  return (
    <div className="text-sm mt-1">
      Cost to run: <CostText u={u} /> · AI budget <BudgetText u={u} />
    </div>
  );
}
