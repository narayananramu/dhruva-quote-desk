import { useEffect, useState } from 'react';
import type { QuoteDetail } from '@/api/contract';
import { useSalesAction } from '@/api/hooks';
import { PillList, PillTrigger, Tabs, TabsContent } from '@/components/ui/tabs';
import { fmtDate, num, ymd } from '@/lib/format';
import { PlainDialog } from './Sheet';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "5 Dec" or "2026-12-05" → IsoDate; null if it cannot be read. */
function parseDay(s: string, now: number): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\s+([a-z]{3})/i);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2].toLowerCase());
  if (mi < 0) return null;
  const today = ymd(now);
  let y = Number(today.slice(0, 4));
  const d = `${y}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (d < today) y += 1;
  return `${y}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
const parseNum = (s: string) => {
  const n = Number(s.replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) && s.trim() !== '' ? Math.round(n) : null;
};

export function ChangeDialog({ quote, open, onOpenChange, now }: {
  quote: QuoteDetail; open: boolean; onOpenChange: (o: boolean) => void; now: number;
}) {
  const act = useSalesAction(quote.rfqId);
  const canChange = quote.actions.includes('change');
  const canAsk = quote.actions.includes('question');
  const [tab, setTab] = useState(canChange ? 'change' : 'back');
  const initialDay = quote.delivery?.parts[0]?.on ?? quote.wants.deliverBy;
  const askItem = quote.stage === 'needs_sales' || !quote.itemCode;
  const [itemCode, setItemCode] = useState('');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [day, setDay] = useState('');
  const [reason, setReason] = useState('');
  const [commit, setCommit] = useState('');
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTab(canChange ? 'change' : 'back');
    setItemCode(quote.itemCode ?? '');
    setQty(quote.quantity != null ? String(quote.quantity) : '');
    setPrice(quote.price ? num(quote.price.unitPrice) : '');
    setDay(initialDay ? fmtDate(initialDay) : '');
    setReason('');
    setCommit('');
    setQuestion('');
    setError(null);
    act.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const done = { onSuccess: () => onOpenChange(false), onError: (e: Error) => setError(e.message) };

  const typed = parseNum(price);
  const sameItem = !(askItem && itemCode.trim() && itemCode.trim().toUpperCase() !== quote.itemCode);
  const ceiling = quote.price ? Math.max(quote.price.contractPrice, quote.usage.smallOrder ? quote.price.minPrice : 0) : null;
  const aboveContract = sameItem && ceiling != null && typed != null && typed > ceiling;
  const asksDiscount = !!quote.price && !quote.usage.smallOrder && typed != null && typed < quote.price.minPrice && quote.newCustomer;

  function save() {
    const q = parseNum(qty);
    const p = parseNum(price);
    const d = day.trim() ? parseDay(day, now) : null;
    if (day.trim() && !d) return setError('Write the date like 5 Dec.');
    setError(null);
    act.mutate(
      {
        type: 'change',
        reason: reason.trim(),
        ...(askItem && itemCode.trim() && itemCode.trim().toUpperCase() !== quote.itemCode ? { itemCode: itemCode.trim().toUpperCase() } : {}),
        ...(q != null && q !== quote.quantity ? { quantity: q } : {}),
        ...(p != null && p !== quote.price?.unitPrice ? { unitPrice: p } : {}),
        ...(d && d !== initialDay ? { deliverBy: d } : {}),
        ...(asksDiscount && parseNum(commit) ? { commitAnnualQty: parseNum(commit)! } : {}),
      },
      done,
    );
  }

  return (
    <PlainDialog open={open} onOpenChange={onOpenChange} title="Change or send back">
      <Tabs value={tab} onValueChange={(v) => { setTab(v); setError(null); }} className="block">
        <PillList className="grid grid-cols-2 mb-4">
          <PillTrigger value="change" disabled={!canChange}>Change something</PillTrigger>
          <PillTrigger value="back" disabled={!canAsk}>Send back with a question</PillTrigger>
        </PillList>
        <TabsContent value="change" className="space-y-3">
          <div className={`grid gap-3 ${askItem ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'}`}>
            {askItem ? <div><label className="lbl" htmlFor="ch-i">Item</label><input id="ch-i" className="input" value={itemCode} onChange={(e) => setItemCode(e.target.value)} /></div> : null}
            <div><label className="lbl" htmlFor="ch-q">Quantity</label><input id="ch-q" className="input" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
            <div><label className="lbl" htmlFor="ch-p">Price each (₹)</label><input id="ch-p" className="input" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
            <div><label className="lbl" htmlFor="ch-d">Delivery</label><input id="ch-d" className="input" value={day} onChange={(e) => setDay(e.target.value)} /></div>
          </div>
          {asksDiscount ? (
            <div><label className="lbl" htmlFor="ch-c">Yearly volume you commit them to (units)</label><input id="ch-c" className="input" inputMode="numeric" value={commit} onChange={(e) => setCommit(e.target.value)} /></div>
          ) : null}
          <div><label className="lbl" htmlFor="ch-r">Why are you changing it?</label><input id="ch-r" className="input" placeholder="e.g. Customer now wants 250 units" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          {aboveContract && quote.price ? <p className="text-sm font-semibold text-red-800" role="alert">Above the contract price ₹{num(quote.price.contractPrice)}</p> : null}
          {error && tab === 'change' ? <p className="text-sm font-semibold text-red-800" role="alert">{error}</p> : null}
          <button className="btn btn-primary w-full" disabled={act.isPending || aboveContract} onClick={save}>Save and check again</button>
        </TabsContent>
        <TabsContent value="back" className="space-y-3">
          <div>
            <label className="lbl" htmlFor="bk">Your question for {quote.account.name}</label>
            <textarea id="bk" className="input h-24" placeholder="e.g. Can you accept delivery on 8 Dec?" value={question} onChange={(e) => setQuestion(e.target.value)} />
          </div>
          {error && tab === 'back' ? <p className="text-sm font-semibold text-red-800" role="alert">{error}</p> : null}
          <button className="btn btn-primary w-full" disabled={act.isPending || !question.trim()}
            onClick={() => act.mutate({ type: 'question', text: question.trim() }, done)}>
            Send question to customer
          </button>
        </TabsContent>
      </Tabs>
    </PlainDialog>
  );
}
