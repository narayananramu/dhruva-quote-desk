import type { CitedStatement, Fact, WinRateView } from '@/api/contract';
import { factLabel, factValue, isClaimFact, profitRange, winRange } from '@/lib/facts';
import { money, num } from '@/lib/format';
import { cn } from '@/lib/utils';

/** One fact as a chip: "Pays in 27 days". Clicking toggles it into the reason when `onToggle` is given. */
export function FactChip({ f, picked, onToggle }: { f: Fact; picked?: boolean; onToggle?: (id: string) => void }) {
  const claim = isClaimFact(f.id);
  const body = (
    <>
      <span className="text-zinc-500">{factLabel(f)}</span> <b className="font-semibold">{factValue(f)}</b>
      {claim ? <span className="text-red-800"> · unverified</span> : null}
    </>
  );
  const cls = cn('fact', picked && 'on', claim && 'claim');
  if (!onToggle || claim)
    return <span className={cls} title={f.id}>{body}</span>;
  return (
    <button type="button" className={cls} title={f.id} aria-pressed={!!picked} onClick={() => onToggle(f.id)}>
      {body}
    </button>
  );
}

/** A referral statement with its cited facts underneath. */
export function CitedLine({ s, facts, picked, onToggle }: {
  s: CitedStatement; facts: Map<string, Fact>; picked?: Set<string>; onToggle?: (id: string) => void;
}) {
  return (
    <li className="py-2">
      <div>{s.text}</div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {s.cites.map((id) => {
          const f = facts.get(id);
          return f ? <FactChip key={id} f={f} picked={picked?.has(id)} onToggle={onToggle} /> : <span key={id} className="fact">{id}</span>;
        })}
      </div>
    </li>
  );
}

/** "52–76% · 40 past quotes" or "Not enough data". */
export function WinCell({ w }: { w: WinRateView | null | undefined }) {
  const r = winRange(w);
  if (!w) return <span className="text-zinc-500">—</span>;
  return r ? <><b>{r}</b> <span className="note inline">· {num(w.quotes)} past quotes</span></> : <span className="text-zinc-500">Not enough data</span>;
}

/** Price, win rate and expected profit rows for the quote card and Finance. */
export function WinTable({ rows }: { rows: { label: string; w: WinRateView | null | undefined }[] }) {
  const shown = rows.filter((r) => r.w);
  if (!shown.length) return null;
  return (
    <div className="mt-5 border border-zinc-200 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left text-zinc-600">
          <tr><th className="px-3 py-2 font-medium">Price</th><th className="font-medium">Win rate</th><th className="font-medium">Expected profit</th></tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {shown.map((r) => (
            <tr key={r.label}>
              <td className="px-3 py-2"><b>{money(r.w!.price)}</b> <span className="text-zinc-500">{r.label}</span></td>
              <td><WinCell w={r.w} /></td>
              <td>{profitRange(r.w) ?? <span className="text-zinc-500">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One line for an option card: "Wins 52–76% · expected profit ₹2,080–₹3,040". */
export function WinLine({ w, className }: { w: WinRateView | null | undefined; className?: string }) {
  if (!w) return null;
  const r = winRange(w);
  return (
    <div className={cn('text-sm text-zinc-700', className)}>
      {r ? <>Wins {r} · expected profit {profitRange(w)}</> : 'Win rate: not enough data'}
    </div>
  );
}
