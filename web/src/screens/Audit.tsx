import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useAudit, useQuotes } from '@/api/hooks';
import { CostLine } from '@/components/CostLine';
import { fmtTimeSec } from '@/lib/format';
import { getLastQuote } from '@/lib/session';

export function Audit() {
  const { rfqId } = useParams();
  const nav = useNavigate();
  const quotes = useQuotes().data?.quotes ?? [];
  const id = rfqId ?? getLastQuote() ?? quotes[0]?.rfqId;
  const audit = useAudit(id);
  useEffect(() => {
    if (!rfqId && id) nav(`/audit/${id}`, { replace: true });
  }, [rfqId, id, nav]);
  const d = audit.data;

  const exportJson = () => {
    if (!d) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${d.quote.rfqId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="max-w-6xl mx-auto px-4 py-6">
      <div className="card">
        <div className="px-5 py-3 border-b border-zinc-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="font-semibold text-lg">Audit trail · {d?.quote.quoteRef ?? ''}</h2>
              <select className="co-sel !text-sm" aria-label="Quote" value={id ?? ''} onChange={(e) => nav(`/audit/${e.target.value}`)}>
                {quotes.map((q) => <option key={q.rfqId} value={q.rfqId}>{q.quoteRef} · {q.account.name}</option>)}
              </select>
            </div>
            <div className="note">
              Append-only. Every step is a Temporal activity, signal or timer in workflow <span className="font-mono">{d?.quote.workflowId ?? ''}</span>. Model: {d?.quote.model ?? 'not configured'}.
            </div>
            {d?.usage ? <CostLine u={d.usage} /> : null}
          </div>
          <button className="btn btn-sm" disabled={!d} onClick={exportJson}>Export JSON</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead className="text-left note">
              <tr className="border-b border-zinc-200"><th scope="col" className="px-5 py-2">Time</th><th scope="col">Actor</th><th scope="col">Event</th><th scope="col">Version</th><th scope="col">Result</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {(d?.rows ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="px-5 py-2 font-mono text-xs">{fmtTimeSec(r.at)}</td>
                  <td>{r.actor}</td>
                  <td>{r.event}</td>
                  <td className="note">{r.version ?? '—'}</td>
                  <td>{r.result == null ? '' : r.tone ? <span className={`badge ${r.tone}`}>{r.result}</span> : r.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
