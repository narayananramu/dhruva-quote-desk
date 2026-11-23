import { useMemo, useState } from 'react';
import { useConfirmStock, useInventory, useNow, useReservations } from '@/api/hooks';
import type { ReservationRow, StockRequest, StockRow } from '@/api/contract';
import { Tag } from '@/components/Chip';
import { PillList, PillTrigger, Tabs, TabsContent } from '@/components/ui/tabs';
import { fmtDate, fmtTime, minutesLeft, num } from '@/lib/format';

const LOC_ORDER = ['Pune', 'Chennai', 'Ahmedabad'];

export function Inventory() {
  const inv = useInventory();
  const res = useReservations();
  const now = useNow();
  const [view, setView] = useState('stock');
  const [q, setQ] = useState('');
  const [loc, setLoc] = useState('');
  const [st, setSt] = useState('');
  const items = inv.data?.items ?? [];
  const locations = useMemo(() => {
    const all = [...new Set(items.map((i) => i.location))];
    return all.sort((a, b) => (LOC_ORDER.indexOf(a) + 1 || 99) - (LOC_ORDER.indexOf(b) + 1 || 99));
  }, [items]);
  const shown = items.filter((r) => {
    const s = q.trim().toLowerCase();
    if (s && !(r.itemCode.toLowerCase().includes(s) || r.description.toLowerCase().includes(s))) return false;
    if (loc && r.location !== loc) return false;
    if (st === 'low' && !r.low) return false;
    if (st === 'old' && !r.countOld) return false;
    if (st === 'res' && !(r.reserved > 0)) return false;
    return true;
  });

  return (
    <main className="max-w-6xl mx-auto px-4 py-5 space-y-5">
      {(inv.data?.requests ?? []).map((r) => <RequestCard key={r.rfqId} r={r} />)}

      <Tabs value={view} onValueChange={setView} className="block space-y-5">
        <PillList className="inline-flex" aria-label="Inventory view">
          <PillTrigger value="stock">Stock</PillTrigger>
          <PillTrigger value="res">Reservations <span className="badge ml-1">{inv.data?.activeReservations ?? 0}</span></PillTrigger>
        </PillList>

        <TabsContent value="stock" className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-zinc-200 flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden="true">⌕</span>
              <input className="input !pl-8" placeholder="Search item or code" aria-label="Search stock" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <select className="input !w-auto" aria-label="Location" value={loc} onChange={(e) => setLoc(e.target.value)}>
              <option value="">All locations</option>
              {locations.map((l) => <option key={l}>{l}</option>)}
            </select>
            <select className="input !w-auto" aria-label="Status" value={st} onChange={(e) => setSt(e.target.value)}>
              <option value="">All stock</option><option value="low">Low stock</option><option value="old">Old count</option><option value="res">Has reservations</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="bg-zinc-50 text-left text-zinc-600">
                <tr>
                  <th className="px-5 py-2 font-medium">Item</th><th className="font-medium">Location</th><th className="font-medium text-right">On hand</th><th className="font-medium text-right">Reserved</th><th className="font-medium text-right">Ordered</th><th className="font-medium text-right pr-6">Available</th><th className="font-medium">Arriving</th><th className="font-medium">Last count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">{shown.map((r) => <StockTr key={r.itemCode} r={r} />)}</tbody>
            </table>
          </div>
          {inv.isSuccess && shown.length === 0 ? <div className="px-5 py-8 text-center text-zinc-500">No items match.</div> : null}
        </TabsContent>

        <TabsContent value="res" className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-zinc-50 text-left text-zinc-600">
                <tr>
                  <th className="px-5 py-2 font-medium">Customer</th><th className="font-medium">Item</th><th className="font-medium text-right pr-8">Units</th><th className="font-medium">Location</th><th className="font-medium">Quote</th><th className="font-medium">Until</th><th className="font-medium pr-5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {(res.data?.reservations ?? []).map((r) => <ResTr key={`${r.quoteRef}-${r.rfqId}-${r.fromStock}-${r.fromPo}-${r.until}`} r={r} now={now} />)}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </main>
  );
}

function RequestCard({ r }: { r: StockRequest }) {
  const confirm = useConfirmStock();
  return (
    <div className="card p-5 !border-amber-300 !bg-amber-50">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="font-semibold text-lg">Confirm stock for {r.itemCode} at {r.location}</div>
          <div className="text-zinc-700">Sales needs {num(r.quantity)} units for {r.accountName}. Last count is old.</div>
        </div>
        <button className="btn btn-primary btn-lg" disabled={confirm.isPending} onClick={() => confirm.mutate({ itemCode: r.itemCode, onHand: r.onHand })}>
          Confirm {num(r.onHand)} on hand
        </button>
      </div>
      {confirm.error ? <p className="mt-2 text-sm font-semibold text-red-800" role="alert">{confirm.error.message}</p> : null}
    </div>
  );
}

function StockTr({ r }: { r: StockRow }) {
  return (
    <tr>
      <td className="px-5 py-3"><div className="font-semibold">{r.itemCode}</div><div className="note">{r.description}</div></td>
      <td>{r.location}</td>
      <td className="text-right">{num(r.onHand)}</td>
      <td className="text-right">{num(r.reserved)}</td>
      <td className="text-right">{num(r.ordered)}</td>
      <td className={`text-right pr-6 font-semibold ${r.low ? 'text-red-800' : ''}`}>{num(r.available)}</td>
      <td>{r.arriving ? <span className="text-zinc-800">{num(r.arriving.quantity)} · {fmtDate(r.arriving.on)}</span> : <span className="text-zinc-400">—</span>}</td>
      <td>{r.countOld ? <Tag tone="red">Old · {fmtTime(r.countedAt)}</Tag> : <Tag tone="green">{fmtTime(r.countedAt)}</Tag>}</td>
    </tr>
  );
}

function ResTr({ r, now }: { r: ReservationRow; now: number }) {
  const po = r.fromPo > 0;
  const units = po ? (r.fromStock > 0 ? `${num(r.fromStock)} now + ${num(r.fromPo)}` : num(r.fromPo)) : num(r.fromStock);
  const until = po ? r.deliverOn.map(fmtDate).join(' / ') : r.until ? fmtTime(r.until) : '—';
  let status: React.ReactNode;
  if (r.status === 'ordered') status = <Tag tone="gray">✓ Ordered</Tag>;
  else if (r.status === 'released') status = <Tag tone="gray">Released</Tag>;
  else if (po) status = <Tag tone="amber">{r.fromStock > 0 ? `Partly from ${r.poId}` : `From ${r.poId}`}</Tag>;
  else status = <Tag tone="amber">{r.until ? Math.max(0, minutesLeft(r.until, now)) : 0} min left</Tag>;
  return (
    <tr>
      <td className="px-5 py-3 font-semibold">{r.accountName}</td>
      <td>{r.itemCode}</td>
      <td className="text-right pr-8">{units}</td>
      <td>{r.location}</td>
      <td>{r.quoteRef}</td>
      <td>{until}</td>
      <td className="pr-5">{status}</td>
    </tr>
  );
}
