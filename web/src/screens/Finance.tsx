import { useMemo, useState } from 'react';
import type { ClaimView, CustomerHistory, Fact, FinanceCase } from '@/api/contract';
import { useAlertMetrics, useDebitNotes, useFinanceDecision, useFinanceQueue, useNow, useOrders, useRecordPayment, useRepReport, useReviewAlert, useVerifyClaim, useWinRate, type OrderRow } from '@/api/hooks';
import { useSessionValue } from '@/lib/session';
import { Chip, Tag } from '@/components/Chip';
import { CitedLine, FactChip, WinLine } from '@/components/Facts';
import { StatBox } from '@/components/Stat';
import { TechnicalDetails, TechRow } from '@/components/TechnicalDetails';
import { factLabel, isClaimFact } from '@/lib/facts';
import { fmtDate, fmtTime, leftText, marginPct, money, num, pct, pctShort, whenText } from '@/lib/format';
import { PRICE_REASON_TEXT } from '@/lib/wording';

const MAX_CITES = 8;

export function Finance() {
  const q = useFinanceQueue();
  const cases = q.data?.cases ?? [];
  return (
    <main className="max-w-4xl mx-auto px-4 py-6 space-y-5">
      {cases.map((c) => <CaseCard key={c.rfqId} c={c} />)}
      {q.isSuccess && cases.length === 0 ? <div className="card p-6 text-center text-zinc-500">Nothing waiting.</div> : null}
      <Orders />
      <DebitNotes />
      <Reps />
      <Metrics />
    </main>
  );
}

const andList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const itemWord = (d: string) => d.split(',')[0].toLowerCase();

function Deadline({ c, now }: { c: FinanceCase; now: number }) {
  if (c.status !== 'waiting') return null;
  const left = leftText(c.deadlineAt, now);
  if (left) return <div className="note mt-1 text-right">Decide by {whenText(c.deadlineAt, now)} · {left} left</div>;
  return (
    <div className="note mt-1 text-right text-red-800 font-semibold">
      Past {whenText(c.deadlineAt, now)} · {c.standingPriceOnly ? 'the price stays' : 'Sales may decide'}
    </div>
  );
}

function CaseCard({ c }: { c: FinanceCase }) {
  const r = c.rules;
  const now = useNow();
  const decide = useFinanceDecision(c.rfqId);
  const asked = c.requestedUnitPrice;
  const [choice, setChoice] = useState<'asked' | 'contract' | 'custom'>('contract');
  const [custom, setCustom] = useState('');
  const [reason, setReason] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const qty = c.quantity;
  const customV = Math.round(Number(custom));
  const customOk = custom.trim() !== '' && Number.isFinite(customV) && customV > 0;
  const customWin = useWinRate(c.rfqId, choice === 'custom' && customOk ? customV : null);
  const price = choice === 'asked' ? asked : choice === 'contract' ? r.contractPrice : customOk ? customV : null;
  const below = price != null && price < r.floorPrice;
  const above = price != null && price > r.contractPrice;
  const discount = price != null && price < r.contractPrice;
  const facts = useMemo(() => new Map((c.referral?.factList ?? []).map((f) => [f.id, f] as const)), [c.referral]);
  const insufficient = c.referral?.dataStatus === 'insufficient';
  const ruleBlocks = facts.get('P5')?.value === false && price != null && price < r.minPrice;
  const openAlert = c.claims.some((x) => x.needsReview);
  const needsReason = discount || insufficient;
  const reasonOk = reason.trim().length >= 3 && (!discount || picked.length > 0);

  const toggle = (id: string) =>
    setPicked((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : xs.length >= MAX_CITES ? xs : [...xs, id]));

  let goLabel = 'Enter a price';
  let goDisabled = true;
  if (openAlert) goLabel = 'Mark the alert first';
  else if (price != null) {
    if (below) goLabel = 'Below max discount';
    else if (ruleBlocks) goLabel = 'New customer: no discount below the minimum';
    else {
      goLabel = `Approve and send ${money(price)} quote`;
      goDisabled = above || (needsReason && !reasonOk);
    }
  }

  const title = c.requestedBy === 'sales'
    ? `Sales wants to offer ${c.account.name} ${money(asked)} each`
    : `${c.account.name} wants ${money(asked)} each`;
  const marginLine = (p: number) => `Margin ${pctShort(marginPct(p, r.unitCost))} · ${money((p - r.unitCost) * qty)} profit`;
  const frozen = c.history.buyerGroup.frozenUntil != null && c.history.buyerGroup.frozenUntil > now;

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          <div className="note">Quote {c.quoteRef} · {num(qty)} × {c.item.code} {itemWord(c.item.description)} · from {c.salesRep} (Sales)</div>
          {c.history.newCustomer || frozen || c.item.clearance ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {c.history.newCustomer ? <Tag tone="amber">New customer</Tag> : null}
              {frozen ? <Tag tone="red">Discounts frozen</Tag> : null}
              {c.item.clearance ? <Tag tone="gray">Clearance</Tag> : null}
            </div>
          ) : null}
        </div>
        <div className="shrink-0">
          {c.status === 'waiting' ? <Chip spec={{ tone: 'amber', icon: '◷', text: 'Needs approval' }} /> : null}
          <Deadline c={c} now={now} />
        </div>
      </div>

      {c.status === 'waiting' ? (
        <div>
          {c.claims.map((cl) => <ClaimAlert key={cl.claimId} cl={cl} />)}

          <div className="mt-5 grid grid-cols-3 rounded-lg border border-zinc-200 divide-x divide-zinc-200 text-sm" aria-label={`Price rules for ${c.item.code}`}>
            <div className="p-3"><div className="note">Contract price</div><div className="font-semibold">{money(r.contractPrice)}</div></div>
            <div className="p-3"><div className="note">Minimum margin {r.minMarginPct}%</div><div className="font-semibold">{money(r.minPrice)} lowest price</div><div className="note">Sales can quote down to here</div></div>
            <div className="p-3"><div className="note">Max discount {r.maxDiscountPct}%</div><div className="font-semibold">{money(r.floorPrice)} lowest price</div><div className="note">Only Finance can approve</div></div>
          </div>

          <fieldset className="mt-5">
            <legend className="font-semibold mb-2">Price to send</legend>
            <div className="grid sm:grid-cols-3 gap-3">
              {asked < r.contractPrice ? (
                <label className="opt">
                  <input type="radio" name={`fp-${c.rfqId}`} checked={choice === 'asked'} onChange={() => setChoice('asked')} />
                  <div className="flex justify-between"><span className="text-2xl font-bold">{money(asked)}</span><Tag tone="amber">Asked</Tag></div>
                  <div className="mt-1">Total {money(asked * qty)}</div>
                  <div className={`${asked < r.minPrice ? 'text-red-800' : 'text-green-800'} font-semibold`}>{marginLine(asked)}</div>
                  <WinLine w={c.winRate.atRequested} className="mt-1" />
                </label>
              ) : null}
              <label className="opt">
                <input type="radio" name={`fp-${c.rfqId}`} checked={choice === 'contract'} onChange={() => setChoice('contract')} />
                <div className="flex justify-between"><span className="text-2xl font-bold">{money(r.contractPrice)}</span><Tag tone="green">Contract price</Tag></div>
                <div className="mt-1">Total {money(r.contractPrice * qty)}</div>
                <div className="text-green-800 font-semibold">{marginLine(r.contractPrice)}</div>
                <WinLine w={c.winRate.atContract} className="mt-1" />
              </label>
              <label className="opt">
                <input type="radio" name={`fp-${c.rfqId}`} checked={choice === 'custom'} onChange={() => setChoice('custom')} />
                <div className="flex justify-between items-center gap-2">
                  <span className="font-semibold">Other price</span>
                  {choice === 'custom' && customOk ? (
                    customV < r.floorPrice ? <Tag tone="red">Not allowed</Tag> : customV >= r.minPrice ? <Tag tone="green">Above minimum</Tag> : <Tag tone="amber">Needs approval</Tag>
                  ) : null}
                </div>
                <div className="relative mt-2">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xl font-bold">₹</span>
                  <input type="number" inputMode="numeric" min={0} step={1} placeholder={String(Math.round((r.floorPrice + r.contractPrice) / 2 / 10) * 10)}
                    aria-label="Other price per unit in rupees" className="input !pl-8 !text-xl !font-bold" value={custom}
                    onFocus={() => setChoice('custom')} onChange={(e) => { setChoice('custom'); setCustom(e.target.value); }} />
                </div>
                <div className="mt-1 text-sm text-zinc-600">
                  {customOk ? (
                    <>
                      Total {money(customV * qty)} · Margin {pct(marginPct(customV, r.unitCost))} · {money((customV - r.unitCost) * qty)} profit
                      {customV < r.floorPrice ? <div className="text-red-800 font-semibold">Below the {money(r.floorPrice)} max discount.</div> : null}
                      {choice === 'custom' ? <WinLine w={customWin.data} className="mt-1" /> : null}
                    </>
                  ) : `${money(r.floorPrice)} to ${money(r.contractPrice)}`}
                </div>
              </label>
            </div>
          </fieldset>

          {c.priceReason ? <div className="mt-4"><span className="note">Customer's reason:</span> {PRICE_REASON_TEXT[c.priceReason]}</div> : null}
          {c.salesReason ? <div className="mt-2"><span className="note">{c.salesRep}'s reason:</span> {c.salesReason}</div> : null}

          {c.referral ? <Referral c={c} facts={facts} picked={picked} onToggle={discount ? toggle : undefined} /> : null}

          <History h={c.history} id={`hist-${c.rfqId}`} />

          {needsReason ? (
            <div className="mt-5">
              <label className="lbl" htmlFor={`fr-${c.rfqId}`}>Reason</label>
              <input id={`fr-${c.rfqId}`} className="input" placeholder={`e.g. Keep a ${num(c.history.units)}-unit account; one-time match`} value={reason} onChange={(e) => setReason(e.target.value)} />
              {discount ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="note">Based on</span>
                  {picked.length ? picked.map((id) => facts.get(id)).filter((f): f is Fact => !!f).map((f) => <FactChip key={f.id} f={f} picked onToggle={toggle} />)
                    : <span className="text-zinc-500">pick facts from the case</span>}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="mt-6 flex flex-wrap items-center gap-4">
            <button className="btn btn-go btn-lg" disabled={goDisabled || decide.isPending}
              onClick={() => price != null && decide.mutate({
                action: 'approve', unitPrice: price,
                ...(needsReason && reason.trim() ? { reason: reason.trim() } : {}),
                ...(discount ? { factIds: picked } : {}),
              })}>
              {goLabel}
            </button>
            <button className="link" disabled={decide.isPending || openAlert} onClick={() => decide.mutate({ action: 'reject', ...(reason.trim() ? { reason: reason.trim() } : {}) })}>Reject</button>
          </div>
          {decide.error ? <p className="mt-2 text-sm font-semibold text-red-800" role="alert">{decide.error.message}</p> : null}
        </div>
      ) : (
        <>
          <Done c={c} facts={facts} />
          <SameBuyer h={c.history} />
          <details className="mt-3">
            <summary className="text-sm">{c.account.name} history</summary>
            <History h={c.history} id={`hist-${c.rfqId}`} />
          </details>
        </>
      )}

      <TechnicalDetails>
        <div className="text-sm mt-2 space-y-1">
          <TechRow label="Workflow"><span className="font-mono">{c.workflowId}</span>{c.status === 'waiting' ? ', waiting for the Finance decision signal' : ''}</TechRow>
          <TechRow label="Summary drafted by">
            Finance referral agent ({c.referral?.model ?? 'code template'}, {c.referral?.promptVersion ?? ''}{c.referral?.fallback ? ', fell back to the code summary' : ''}). Every statement cites code-built facts; code checked each one.
          </TechRow>
          <TechRow label="Price rules">
            per item, owned by Finance · {c.item.code}: minimum margin {r.minMarginPct}% ({money(r.minPrice)}), max discount {r.maxDiscountPct}% ({money(r.floorPrice)}), never below cost {money(r.unitCost)}{c.item.clearance ? ' unless clearance' : ''}
          </TechRow>
          <TechRow label="Margin check">
            code · {money(asked)} gives {pct(marginPct(asked, r.unitCost))}
            {asked < r.minPrice ? `, below ${r.minMarginPct}%` : ''}
            {asked >= r.floorPrice ? ', within max discount' : ', below max discount'} · below {money(r.floorPrice)} is blocked for everyone
          </TechRow>
          <TechRow label="Deadline">4 business hours, {whenText(c.deadlineAt, now)}. {c.standingPriceOnly ? 'Claim quote or frozen group: after it, the standing price holds.' : 'After it, the sales rep decides on the same figures.'}</TechRow>
          {c.injection ? <TechRow label="Prompt injection">email said “{c.injection.phrase.toLowerCase()}”; checks ran unchanged</TechRow> : null}
          <TechRow label="After approval">the workflow rechecks stock and price, then sends the quote</TechRow>
        </div>
      </TechnicalDetails>
    </div>
  );
}

function Referral({ c, facts, picked, onToggle }: { c: FinanceCase; facts: Map<string, Fact>; picked: string[]; onToggle?: (id: string) => void }) {
  const ref = c.referral!;
  const set = new Set(picked);
  const cited = new Set([...ref.summary, ...ref.considerations].flatMap((s) => s.cites));
  const rest = ref.factList.filter((f) => !cited.has(f.id) && !isClaimFact(f.id));
  const claims = ref.factList.filter((f) => isClaimFact(f.id) && f.key !== 'claim.status');
  return (
    <section className="mt-6" aria-labelledby={`ref-${c.rfqId}`}>
      <h3 id={`ref-${c.rfqId}`} className="font-semibold">Case</h3>
      {ref.dataStatus === 'insufficient' ? (
        <div className="banner amber !mt-2">
          <b>Missing data:</b> {ref.missing.map((id) => (facts.get(id) ? factLabel(facts.get(id)!) : id)).join(', ')}.
        </div>
      ) : null}
      <ul className="divide-y divide-zinc-100">
        {[...ref.summary, ...ref.considerations].map((s, i) => <CitedLine key={i} s={s} facts={facts} picked={set} onToggle={onToggle} />)}
      </ul>
      {claims.length ? (
        <div className="mt-1 flex flex-wrap gap-1.5">{claims.map((f) => <FactChip key={f.id} f={f} />)}</div>
      ) : null}
      {rest.length ? (
        <details className="mt-2">
          <summary className="text-sm">All facts</summary>
          <div className="mt-2 flex flex-wrap gap-1.5">{rest.map((f) => <FactChip key={f.id} f={f} picked={set.has(f.id)} onToggle={onToggle} />)}</div>
        </details>
      ) : null}
    </section>
  );
}

const LEVEL = {
  likely_fake: { tone: 'red', text: 'Likely fake' },
  check: { tone: 'amber', text: 'Check' },
  no_concern: { tone: 'gray', text: 'No concern' },
} as const;

const citeWord = (id: string) => (id.startsWith('D') ? 'rival document' : id.startsWith('F') ? 'this request' : id);

function ClaimAlert({ cl }: { cl: ClaimView }) {
  const review = useReviewAlert();
  const verify = useVerifyClaim();
  const [channel, setChannel] = useState('');
  const a = cl.alert;
  const lv = LEVEL[a.level];
  const reasons = [
    ...a.signals.map((s) => ({ text: s.text, quote: s.evidence, cites: s.cites })),
    ...a.findings.filter((f) => !a.signals.some((s) => s.text === f.text)).map((f) => ({ text: f.text, quote: f.quote, cites: f.cites })),
  ];
  const err = review.error ?? verify.error;
  return (
    <section className={`alert ${lv.tone}`} aria-label="Rival price alert">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={lv.tone}>{lv.text}</Tag>
        <b>{cl.rival ?? 'A rival'}{cl.claimedPrice != null ? ` at ${money(cl.claimedPrice)} each` : ''}</b>
        <span className="note">{cl.status === 'unverified' ? 'Unverified claim' : cl.status === 'fake' ? 'Confirmed fake' : 'Confirmed genuine'}{cl.rivalGstin ? ` · GSTIN ${cl.rivalGstin}` : ''}</span>
      </div>
      {reasons.length ? (
        <ul className="mt-3 space-y-2">
          {reasons.map((x, i) => (
            <li key={i}>
              <div>{x.text}</div>
              <div className="mt-1 flex flex-wrap gap-1.5 items-center">
                {x.quote ? <span className="fact"><span className="text-zinc-500">Quote</span> <b className="font-semibold">“{x.quote}”</b></span> : null}
                {[...new Set(x.cites.map(citeWord))].map((w) => <span key={w} className="fact text-zinc-500">{w}</span>)}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {cl.attachmentText ? <div className="doc mt-3">{cl.attachmentText}</div> : null}

      <div className="mt-4">
        {!a.review ? (
          <div className="flex flex-wrap items-center gap-4">
            <button className="btn" disabled={review.isPending} onClick={() => review.mutate({ alertId: a.alertId, verdict: 'correct' })}>Correct</button>
            <button className="link" disabled={review.isPending} onClick={() => review.mutate({ alertId: a.alertId, verdict: 'wrong' })}>Wrong</button>
          </div>
        ) : (
          <div className="text-sm"><b>Alert marked {a.review.verdict}</b> by {a.review.by} at {fmtTime(a.review.at)}.</div>
        )}
        {a.review && !cl.verification ? (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="grow min-w-56">
              <label className="lbl" htmlFor={`vc-${cl.claimId}`}>Checked with their buyer's officer by</label>
              <input id={`vc-${cl.claimId}`} className="input" placeholder="e.g. phone, CRM number" value={channel} onChange={(e) => setChannel(e.target.value)} />
            </div>
            <button className="btn" disabled={verify.isPending || channel.trim().length < 3} onClick={() => verify.mutate({ claimId: cl.claimId, result: 'genuine', channel: channel.trim() })}>Genuine</button>
            <button className="btn" disabled={verify.isPending || channel.trim().length < 3} onClick={() => verify.mutate({ claimId: cl.claimId, result: 'fake', channel: channel.trim() })}>Fake</button>
          </div>
        ) : null}
        {cl.verification ? (
          <div className="text-sm mt-1"><b>Verified {cl.verification.result}</b> by {cl.verification.by} ({cl.verification.channel}) at {fmtTime(cl.verification.at)}.</div>
        ) : null}
        {err ? <p className="mt-2 text-sm font-semibold text-red-800" role="alert">{err.message}</p> : null}
      </div>
    </section>
  );
}

function Done({ c, facts }: { c: FinanceCase; facts: Map<string, Fact> }) {
  const d = c.decision;
  let head = 'Rejected. Sales will tell the customer.';
  let body: string | null = null;
  let tone = 'bg-green-50 border-green-300 text-green-900';
  if (c.status === 'timed_out') {
    head = 'No decision by the deadline. The standing price holds.';
    tone = 'bg-zinc-50 border-zinc-300 text-zinc-900';
  } else if (c.status === 'approved' && d) {
    const price = d.unitPrice ?? c.requestedUnitPrice;
    if (d.outcome === 'sent') {
      head = `Approved. Quote sent to ${c.account.name}.`;
      body = `${num(c.quantity)} × ${c.item.code} at ${money(price)} each, total ${money(price * c.quantity)}. Sent to ${d.sentTo ?? c.account.email} at ${fmtTime(d.sentAt ?? d.at)}.`;
    } else if (d.outcome === 'checking') head = 'Approved. Rechecking stock and price.';
    else head = `Approved at ${money(price)} each. Sales is finishing the stock check.`;
  }
  const cited = (d?.factIds ?? []).map((id) => facts.get(id)).filter((f): f is Fact => !!f);
  return (
    <div className={`mt-5 rounded-lg px-4 py-4 border ${tone}`} role="status">
      <div className="text-lg font-semibold">{head}</div>
      {body ? <div>{body}</div> : null}
      {d?.reason ? (
        <div className="mt-2">
          <span className="font-semibold">Reason{d.byRole === 'sales' ? ' (sales rep, after the deadline)' : ''}:</span> {d.reason}
          {d.insufficientData ? <Tag tone="amber" className="ml-2">Missing data</Tag> : null}
        </div>
      ) : null}
      {cited.length ? <div className="mt-2 flex flex-wrap gap-1.5">{cited.map((f) => <FactChip key={f.id} f={f} />)}</div> : null}
    </div>
  );
}

function History({ h, id }: { h: CustomerHistory; id: string }) {
  const active = h.commitments.filter((x) => x.active);
  return (
    <section className="mt-6" aria-labelledby={id}>
      <h3 id={id} className="font-semibold mb-3">{h.account.name} · last {h.months} months</h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatBox label="Revenue" value={money(h.revenue)} note={`${num(h.units)} units, ${h.orders} ${h.orders === 1 ? 'order' : 'orders'}`} />
        <StatBox label="Average margin" value={pct(h.avgMarginPct)} note={`Company ${h.companyMarginPct}%`} />
        <StatBox label="Discounts approved" value={`${h.discounts.count} of ${h.orders} ${h.orders === 1 ? 'order' : 'orders'}`} note={h.discounts.months.length ? andList(h.discounts.months) : undefined} />
        <StatBox label="Pays in" value={h.paysInDays != null ? `${h.paysInDays} days` : '—'} note={`Terms ${h.termsDays} · ${h.overdue ? `${h.overdue} overdue` : 'none overdue'}`} />
      </div>
      <SameBuyer h={h} />
      {active.length ? (
        <div className="mt-3 text-sm">
          {active.map((x) => (
            <div key={x.id}><b>Yearly commitment:</b> {num(x.annualQty)} × {x.itemCode} by {x.rep}, to {fmtDate(x.endsOn)} · {num(x.orderedQty)} ordered{x.shortfall > 0 ? `, ${num(x.shortfall)} short` : ''}</div>
          ))}
        </div>
      ) : null}
      <div className="mt-3 border border-zinc-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-zinc-600">
            <tr><th className="px-3 py-2 font-medium">Date</th><th className="font-medium">Units</th><th className="font-medium">Price</th><th className="font-medium">Margin</th><th className="font-medium">Note</th></tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {h.rows.map((row, i) => (
              <tr key={i} className={row.discounted ? 'bg-amber-50/60' : ''}>
                <td className="px-3 py-2">{fmtDate(row.date)}</td>
                <td>{num(row.units)}</td>
                <td>{money(row.unitPrice)}</td>
                <td className={row.discounted ? 'text-red-800' : ''}>{pct(row.marginPct)}</td>
                <td className={row.discounted ? 'text-zinc-600' : 'text-zinc-500'}>{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SameBuyer({ h }: { h: CustomerHistory }) {
  if (h.buyerGroup.accounts.length <= 1) return null;
  return (
    <div className="mt-3 text-sm">
      <b>Same buyer:</b> {andList(h.buyerGroup.names.filter((n) => n !== h.account.name))} ({andList([...new Set(h.buyerGroup.links.map((l) => VIA[l.via]))])})
    </div>
  );
}

const VIA = { gstin: 'same GSTIN', pan: 'same PAN', bank_account: 'same bank account', address: 'same address', email_domain: 'same email domain' } as const;
const NOTE_KIND = { payment_days: 'Paid late', volume: 'Commitment short', reprice: 'Part cancelled' } as const;

/** A3: discounts clawed back because their condition broke. */
function DebitNotes() {
  const q = useDebitNotes();
  const notes = q.data?.debitNotes ?? [];
  if (!q.isSuccess) return null;
  return (
    <section className="card p-5" aria-labelledby="dn">
      <h2 id="dn" className="text-lg font-semibold mb-3">Debit notes</h2>
      {notes.length === 0 ? <div className="text-sm text-zinc-500">None yet.</div> : <div className="border border-zinc-200 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-zinc-600">
            <tr><th className="px-3 py-2 font-medium">Note</th><th className="font-medium">Customer</th><th className="font-medium">Why</th><th className="font-medium">Amount</th><th className="font-medium pr-3">From rep</th></tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {notes.map((n) => (
              <tr key={n.noteRef} title={n.detail}>
                <td className="px-3 py-2 whitespace-nowrap">{n.noteRef}</td>
                <td>{n.accountName}</td>
                <td>{NOTE_KIND[n.kind]}{n.orderRef ? ` · ${n.orderRef}` : ''}</td>
                <td className="font-semibold">{money(n.amountInr)}</td>
                <td className="pr-3">{n.commissionInr ? `${money(n.commissionInr)} · ${n.rep}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
    </section>
  );
}

/** A3: booked orders not yet paid. Recording a late payment raises a debit note for a faster-payment discount. */
function Orders() {
  const orders = (useOrders().data?.orders ?? []).filter((o) => o.paidDays == null);
  if (!orders.length) return null;
  return (
    <section className="card p-5" aria-labelledby="orders">
      <h2 id="orders" className="text-lg font-semibold mb-3">Orders awaiting payment</h2>
      <div className="border border-zinc-200 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-zinc-600">
            <tr><th className="px-3 py-2 font-medium">Order</th><th className="font-medium">Customer</th><th className="font-medium">Items</th><th className="font-medium">Pay within</th><th className="font-medium pr-3">Paid after</th></tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {orders.map((o) => <OrderLine key={o.orderRef} o={o} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OrderLine({ o }: { o: OrderRow }) {
  const pay = useRecordPayment();
  const session = useSessionValue();
  const due = o.conditions.find((c) => c.kind === 'payment_days' && c.status === 'open')?.required ?? o.termsDays;
  const [days, setDays] = useState(due != null ? String(due + 10) : '30');
  const d = Math.round(Number(days));
  const ok = days.trim() !== '' && Number.isInteger(d) && d >= 0 && d <= 365;
  return (
    <tr>
      <td className="px-3 py-2 whitespace-nowrap">{o.orderRef}</td>
      <td>{session.accounts.find((a) => a.code === o.account)?.name ?? o.account}</td>
      <td>{num(o.quantity)} × {o.itemCode} at {money(o.unitPrice)}</td>
      <td>{due != null ? `${due} days` : '—'}</td>
      <td className="pr-3 py-2">
        <div className="flex items-center gap-2">
          <input className="input !w-20" inputMode="numeric" aria-label={`Days to pay for ${o.orderRef}`} value={days} onChange={(e) => setDays(e.target.value)} />
          <button className="btn btn-sm" disabled={!ok || pay.isPending} onClick={() => pay.mutate({ orderRef: o.orderRef, paidDays: d })}>Record payment</button>
        </div>
        {pay.error ? <div className="text-red-800 font-semibold" role="alert">{pay.error.message}</div> : null}
      </td>
    </tr>
  );
}

/** A4: one row per rep, last 12 months; a flagged rep is in the reviewer's sample. */
function Reps() {
  const reps = useRepReport().data?.reps ?? [];
  if (!reps.length) return null;
  return (
    <section className="card p-5" aria-labelledby="reps">
      <h2 id="reps" className="text-lg font-semibold mb-3">Reps · last 12 months</h2>
      <div className="border border-zinc-200 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-zinc-600">
            <tr>
              <th className="px-3 py-2 font-medium">Rep</th><th className="font-medium">Orders</th><th className="font-medium">Discounted</th>
              <th className="font-medium">Sent to Finance</th><th className="font-medium">By phone</th><th className="font-medium">Margin vs others</th><th className="font-medium pr-3">Check</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {reps.map((r) => (
              <tr key={r.rep} className={r.flags.length ? 'bg-amber-50/60' : ''}>
                <td className="px-3 py-2 font-medium whitespace-nowrap">{r.rep}</td>
                <td>{r.orders}</td>
                <td>{pct(r.discountRatePct)}</td>
                <td>{r.financeRevisions}</td>
                <td>{pct(r.phoneSharePct)}</td>
                <td className={r.marginVsPeersPts != null && r.marginVsPeersPts < 0 ? 'text-red-800' : ''}>
                  {pct(r.marginPct)}{r.marginVsPeersPts != null ? ` (${r.marginVsPeersPts > 0 ? '+' : ''}${r.marginVsPeersPts} pts)` : ''}
                </td>
                <td className="pr-3">{r.flags.length ? <Tag tone="amber">{r.flags.join(', ')}</Tag> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Metrics() {
  const m = useAlertMetrics().data?.metrics;
  if (!m || m.alerts === 0) return null;
  const p = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  return (
    <div className="text-sm text-zinc-600 px-1">
      Rival price alerts: {m.alerts} raised · {m.marked} marked · {m.correct} correct · precision {p(m.precision)} · {m.confirmedFakes} confirmed fake · recall {p(m.recall)}
    </div>
  );
}
