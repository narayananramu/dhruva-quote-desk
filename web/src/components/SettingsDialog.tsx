import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useSettings, useSettingsActions, useNow } from '@/api/hooks';
import { Switch } from '@/components/ui/switch';
import { fmtTime } from '@/lib/format';
import { SheetDialog } from './Sheet';

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const settings = useSettings(open);
  const act = useSettingsActions();
  const now = useNow();
  const nav = useNavigate();
  const [pick, setPick] = useState('');
  const tests = settings.data?.testRequests ?? [];
  const chosen = pick || tests[0]?.id || '';
  const stale = act.stale.isPending ? !!act.stale.variables : !!settings.data?.staleStock;

  return (
    <SheetDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      footer={
        <div className="px-6 py-4 border-t border-zinc-200 bg-zinc-50 flex items-center justify-between rounded-b-[14px]">
          <button className="link !px-0" disabled={act.reset.isPending}
            onClick={() => act.reset.mutate(undefined, { onSuccess: () => { onOpenChange(false); nav('/sales'); } })}>
            {act.reset.isPending ? <><span className="spin">↻</span> Reset demo</> : 'Reset demo'}
          </button>
          <button className="btn btn-primary" onClick={() => onOpenChange(false)}>Done</button>
        </div>
      }
    >
      <div className="px-6 py-5 space-y-6">
        <section>
          <h3 className="set-h">Test request</h3>
          <div className="flex gap-2">
            <select className="input flex-1" aria-label="Test request" value={chosen} onChange={(e) => setPick(e.target.value)}>
              {tests.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <button className="btn btn-primary" disabled={!chosen || act.load.isPending}
              onClick={() => act.load.mutate(chosen, { onSuccess: (r) => { onOpenChange(false); nav(`/sales/${r.rfqId}`); } })}>
              Load
            </button>
          </div>
        </section>
        <section>
          <h3 className="set-h">Simulation</h3>
          <div className="set-row">
            <div>
              <div className="font-medium">Time</div>
              <div className="note">Now <b className="text-zinc-900">{fmtTime(now)}</b></div>
            </div>
            <div className="seg" role="group" aria-label="Move time forward">
              <button onClick={() => act.advance.mutate(5)}>+5 min</button>
              <button onClick={() => act.advance.mutate(11)}>+11 min</button>
            </div>
          </div>
          <div className="set-row">
            <div>
              <div className="font-medium">Stock data is old</div>
            </div>
            <Switch checked={stale} onCheckedChange={(v) => act.stale.mutate(v)} aria-label="Stock data is old" />
          </div>
        </section>
      </div>
    </SheetDialog>
  );
}
