import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Account } from '@/api/contract';
import { usePhoneCall } from '@/api/hooks';
import { PlainDialog } from './Sheet';

export function PhoneCallDialog({ open, onOpenChange, accounts }: { open: boolean; onOpenChange: (o: boolean) => void; accounts: Account[] }) {
  const [cust, setCust] = useState('Acme Pumps');
  const [caller, setCaller] = useState('R. Shah');
  const [ask, setAsk] = useState('200 sealed 25mm bearings, Pune, by 5 Dec. Wants a firm price.');
  const call = usePhoneCall();
  // One key per opened dialog: a double click on Create quote makes one RFQ, not two.
  const key = useRef('');
  const busy = useRef(false);
  useEffect(() => {
    if (open) {
      key.current = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      busy.current = false;
    }
  }, [open]);
  const nav = useNavigate();
  const account = accounts.find((a) => a.name.toLowerCase() === cust.trim().toLowerCase() || a.code === cust.trim());

  return (
    <PlainDialog open={open} onOpenChange={onOpenChange} label="Log a phone call">
      <form className="space-y-3" onSubmit={(e) => {
        e.preventDefault();
        if (!account || busy.current) return;
        busy.current = true;
        call.mutate({ account: account.code, caller, text: ask, key: key.current }, {
          onSuccess: (r) => { onOpenChange(false); nav(`/sales/${r.rfqId}`); },
          onError: () => { busy.current = false; },
        });
      }}>
        <div className="font-semibold text-lg">Log a phone call</div>
        <div>
          <label className="lbl" htmlFor="cust">Customer</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" aria-hidden="true">⌕</span>
            <input id="cust" className="input !pl-8 !pr-8" list="custs" value={cust} onChange={(e) => setCust(e.target.value)} placeholder="Type a customer name" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 text-xs" aria-hidden="true">▼</span>
            <datalist id="custs">{accounts.map((a) => <option key={a.code} value={a.name} />)}</datalist>
          </div>
        </div>
        <div><label className="lbl" htmlFor="caller">Who called</label><input id="caller" className="input" value={caller} onChange={(e) => setCaller(e.target.value)} /></div>
        <div><label className="lbl" htmlFor="ask">What they asked for</label><textarea id="ask" className="input h-24" value={ask} onChange={(e) => setAsk(e.target.value)} /></div>
        <button className="btn btn-primary btn-lg w-full" disabled={!account || !ask.trim() || call.isPending}>Create quote</button>
        {call.error ? <p className="text-sm text-red-800">{call.error.message}</p> : null}
      </form>
    </PlainDialog>
  );
}
