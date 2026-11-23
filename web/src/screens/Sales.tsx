import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { DeliveryOption, LossReason, QuoteDetail, SalesAction } from '@/api/contract';
import { useFinanceDecision, useNow, useQuote, useQuotes, useRefreshStock, useSalesAction, useWinRate } from '@/api/hooks';
import { Banner } from '@/components/Banner';
import { ChangeDialog } from '@/components/ChangeDialog';
import { Chip, Tag } from '@/components/Chip';
import { Stat } from '@/components/Stat';
import { WinLine, WinTable } from '@/components/Facts';
import { BudgetText, CostText } from '@/components/CostLine';
import { TechnicalDetails, TechRow } from '@/components/TechnicalDetails';
import { fmtDate, fmtTime, minutesLeft, money, num, pct, pctShort } from '@/lib/format';
import { setLastQuote } from '@/lib/session';
import {
  bannerFor, CHANNEL_WORD, chipFor, deliveryText, LOSS_COUNTS, LOSS_LABEL, optionText, primaryFor,
} from '@/lib/wording';

export function Sales() {
  const { rfqId } = useParams();
  const nav = useNavigate();
  const list = useQuotes();
  const quotes = list.data?.quotes ?? [];

  useEffect(() => {
    if (!rfqId && quotes.length) nav(`/sales/${quotes[0].rfqId}`, { replace: true });
  }, [rfqId, quotes, nav]);
  useEffect(() => {
    if (rfqId) setLastQuote(rfqId);
  }, [rfqId]);

  return (
    <main className="max-w-6xl mx-auto px-4 py-5 grid md:grid-cols-[300px_1fr] gap-5 items-start">
      <div className="card overflow-hidden">
        <h2 className="px-4 py-3 border-b border-zinc-200 font-semibold">My quotes</h2>
        <div className="divide-y divide-zinc-200">
          {quotes.map((q) => (
            <button key={q.rfqId} className="row" aria-current={q.rfqId === rfqId} onClick={() => nav(`/sales/${q.rfqId}`)}>
              <div className="font-semibold">{q.account.name}</div>
              <div className="text-zinc-700">
                {q.quantity != null && q.itemCode ? `${num(q.quantity)} × ${q.itemCode}` : q.quoteRef}
                {q.total != null ? ` · ${money(q.total)}` : ''}
              </div>
              <Chip spec={chipFor(q)} className="mt-1" />
            </button>
          ))}
          {list.isSuccess && quotes.length === 0 ? <div className="px-4 py-8 text-center text-zinc-500">No quotes yet.</div> : null}
        </div>
      </div>
      {rfqId ? <QuotePanel key={rfqId} rfqId={rfqId} /> : null}
    </main>
  );
}

function QuotePanel({ rfqId }: { rfqId: string }) {
  const { data, error } = useQuote(rfqId);
  const now = useNow();
  if (error) return <div className="card p-6 min-w-0 text-zinc-600">{error.message}</div>;
  if (!data) return <div className="card p-6 min-w-0 h-64" aria-busy="true" />;
  return <QuoteCard q={data.quote} now={now} />;
}

const isPoQuote = (q: QuoteDetail) => q.stage === 'short' || (!!q.delivery && q.delivery.id !== 'stock') || (q.stage === 'lost' && !!q.deliveryOffer);

function QuoteCard({ q, now }: { q: QuoteDetail; now: number }) {
  const act = useSalesAction(q.rfqId);
  const [dialog, setDialog] = useState(false);
  const [reopen, setReopen] = useState(false);
  const options = q.deliveryOptions;
  const [optId, setOptId] = useState<string | null>(null);
  const selected = options.find((o) => o.id === optId) ?? options[0] ?? null;
  const banner = bannerFor(q, now);
  const primary = primaryFor(q, selected);
  const canChange = q.actions.includes('change') || q.actions.includes('question');
  const run = (a: SalesAction) => act.mutate(a);

  useEffect(() => {
    if (q.stage !== 'lost') setReopen(false);
  }, [q.stage]);

  const financeLayout = q.stage === 'with_finance' || q.stage === 'finance_rejected' || q.stage === 'blocked';
  const po = isPoQuote(q);
  const subtitle = financeLayout
    ? `Quote ${q.quoteRef}${q.quantity != null && q.itemCode ? ` · ${num(q.quantity)} × ${q.itemCode}` : ''}`
    : `Quote ${q.quoteRef} · asked by ${CHANNEL_WORD[q.channel]} at ${fmtTime(q.receivedAt)}${po && q.wants.deliverBy ? ` · wants delivery by ${fmtDate(q.wants.deliverBy)}` : ''}`;

  const buttons = (
    <>
      {primary && !(primary.action === 'reopen_form' && reopen) ? (
        <button className={`btn btn-lg ${primary.go ? 'btn-go' : 'btn-primary'}`} disabled={act.isPending}
          onClick={() => (primary.action === 'reopen_form' ? setReopen(true) : run(primary.action))}>
          {act.isPending && primary.action !== 'reopen_form' ? <span className="spin" aria-hidden="true">↻</span> : null}
          {primary.label}
        </button>
      ) : null}
      {canChange ? <button className="link" onClick={() => setDialog(true)}>Change or send back</button> : null}
    </>
  );

  return (
    <div className="card p-6 min-w-0">
      <h2 className="text-xl font-semibold">Quote for {q.account.name}</h2>
      <div className="note">{subtitle}</div>
      <Tags q={q} />
      {banner ? <Banner spec={banner} /> : null}

      {financeLayout ? <FinanceFigures q={q} /> : q.price ? <Figures q={q} po={po} /> : null}
      {q.price && !q.usage.smallOrder && q.stage !== 'lost' ? <Wins q={q} /> : null}
      {q.stage === 'with_finance' && q.finance?.status === 'waiting' && q.finance.repMayDecide && !q.finance.standingPriceOnly ? <RepDecision q={q} /> : null}
      {po && q.deliveryOffer ? <StockStrip q={q} /> : null}
      {financeLayout ? <StockLine q={q} /> : null}
      {!financeLayout && !po && CHECK_STAGES.includes(q.stage) && q.price ? <Checks q={q} now={now} /> : null}
      {q.stage === 'lost' ? <LossCells q={q} onTag={(reason) => run({ type: 'tag_loss', reason })} /> : null}
      {q.stage === 'lost' && reopen ? <ReopenForm q={q} onSend={run} pending={act.isPending} /> : null}

      {q.stage === 'short' && options.length ? (
        <fieldset className="mt-5">
          <legend className="font-semibold mb-2">Delivery to offer</legend>
          <div className="grid sm:grid-cols-2 gap-3">
            {options.map((o) => <OptionCard key={o.id} o={o} q={q} checked={selected?.id === o.id} onPick={() => setOptId(o.id)} />)}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-4">{buttons}</div>
        </fieldset>
      ) : primary || canChange ? (
        <div className="mt-5 flex flex-wrap items-center gap-4">{buttons}</div>
      ) : null}
      {act.error ? <p className="mt-2 text-sm font-semibold text-red-800" role="alert">{act.error.message}</p> : null}

      {!financeLayout ? <Technical q={q} po={po} /> : null}
      <ChangeDialog quote={q} open={dialog} onOpenChange={setDialog} now={now} />
    </div>
  );
}

const LEVEL_TAG = {
  likely_fake: { tone: 'red', text: 'Rival price: likely fake' },
  check: { tone: 'amber', text: 'Rival price: check' },
  no_concern: { tone: 'gray', text: 'Rival price: no concern' },
} as const;

function Tags({ q }: { q: QuoteDetail }) {
  const lv = q.claim ? LEVEL_TAG[q.claim.level] : null;
  if (!q.item?.clearance && !lv && !q.frozen && !q.newCustomer && q.stockPriority) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {q.newCustomer ? <Tag tone="gray">New customer</Tag> : null}
      {q.item?.clearance ? <Tag tone="gray">Clearance</Tag> : null}
      {lv ? <Tag tone={lv.tone}>{lv.text}</Tag> : null}
      {q.frozen ? <Tag tone="red">Discounts frozen</Tag> : null}
      {!q.stockPriority ? <Tag tone="amber">Countered: no stock priority</Tag> : null}
    </div>
  );
}

function Wins({ q }: { q: QuoteDetail }) {
  const p = q.price!;
  const at = p.unitPrice === p.contractPrice ? 'contract price' : q.finance?.requestedBy === 'customer' || p.targetSource === 'customer' ? 'asked' : 'this quote';
  return (
    <WinTable rows={[
      { label: at, w: p.winRate },
      ...(p.unitPrice !== p.contractPrice ? [{ label: 'contract price', w: p.winRateAtContract }] : []),
    ]} />
  );
}

/** After the Finance deadline the rep decides on the same figures (not on claim quotes or frozen groups). */
function RepDecision({ q }: { q: QuoteDetail }) {
  const decide = useFinanceDecision(q.rfqId);
  const [reason, setReason] = useState('');
  const asked = q.finance!.requestedUnitPrice;
  const w = q.price?.winRate;
  const factIds = w?.enough ? ['F6', 'W7', 'W8', 'W11', 'W12'] : ['F6', 'F13', 'P1', 'P5'];
  return (
    <div className="mt-5 rounded-lg border border-zinc-300 p-5">
      <label className="lbl" htmlFor={`rd-${q.rfqId}`}>Reason</label>
      <input id={`rd-${q.rfqId}`} className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button className="btn btn-go btn-lg" disabled={decide.isPending || reason.trim().length < 3}
          onClick={() => decide.mutate({ action: 'approve', unitPrice: asked, reason: reason.trim(), factIds })}>
          Approve and send {money(asked)} quote
        </button>
        <button className="link" disabled={decide.isPending} onClick={() => decide.mutate({ action: 'reject', ...(reason.trim() ? { reason: reason.trim() } : {}) })}>Reject</button>
      </div>
      {decide.error ? <p className="mt-2 text-sm font-semibold text-red-800" role="alert">{decide.error.message}</p> : null}
    </div>
  );
}

const CHECK_STAGES = ['ready', 'stale', 'with_inventory', 'hold_expired', 'sent', 'ordered', 'quote_expired'];

function Figures({ q, po }: { q: QuoteDetail; po: boolean }) {
  const p = q.price!;
  const qty = q.quantity ?? 0;
  const wantsDay = q.wants.deliverBy ? fmtDate(q.wants.deliverBy) : null;
  const place = q.wants.deliverTo ?? q.item?.location ?? null;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-5">
      <Stat label="Quote total" big value={money(p.total)} note={`${num(qty)} × ${money(p.unitPrice)}`} />
      <Stat label="Item" value={q.item?.description ?? q.itemCode} note={`${q.itemCode} · ${num(qty)} units`} />
      <Stat label="Profit margin" value={`${pctShort(p.marginPct)} · ${money(p.profit)}`} note={`Minimum allowed ${p.minMarginPct}%`} />
      {po ? (
        <Stat label="Customer wants" value={[wantsDay, place].filter(Boolean).join(', ')} note={q.wants.firm ? 'Firm price' : undefined} />
      ) : (
        <Stat label="Delivery" value={deliveryText(q)} note={q.wants.firm ? 'Firm price' : undefined} />
      )}
    </div>
  );
}

function FinanceFigures({ q }: { q: QuoteDetail }) {
  const p = q.price;
  const qty = q.quantity ?? 0;
  const asked = q.finance?.requestedUnitPrice ?? q.wants.unitPrice ?? p?.unitPrice ?? 0;
  if (!p) return null;
  const m = ((asked - p.unitCost) / asked) * 100;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-5">
      <Stat label={q.finance?.requestedBy === 'sales' ? 'New offer' : 'Customer asked'} big value={money(asked * qty)} note={`${num(qty)} × ${money(asked)}`} />
      <Stat label="At contract price" value={money(p.contractTotal)} note={`${num(qty)} × ${money(p.contractPrice)}`} />
      <Stat label={`Profit margin at ${money(asked)}`} value={pct(m)} valueClass={m < p.minMarginPct ? 'text-red-800' : ''} note={`Minimum allowed ${p.minMarginPct}%`} />
      {q.stage === 'finance_rejected' ? <Stat label="Finance decision" value="Rejected" valueClass="text-red-800" />
        : q.stage === 'blocked' ? <Stat label="Why it stopped" value="Below the max discount" valueClass="text-red-800" />
        : <Stat label="Why it's with Finance" value={asked < p.minPrice ? 'Discount below the minimum' : 'Lower than the sent price'} />}
    </div>
  );
}

function StockLine({ q }: { q: QuoteDetail }) {
  const refresh = useRefreshStock();
  const s = q.stock;
  if (!s) return null;
  return (
    <div className="mt-5 border-t border-zinc-200 pt-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className={`ico-ok ${s.enough && !s.countOld ? '' : 'ico-bad'}`} aria-hidden="true">{s.enough && !s.countOld ? '✓' : '!'}</span>
        <div>
          <b>{num(s.available)} {s.itemCode} available</b> at {s.location} · needs {num(s.needed)}
          <div className="note">Counted at {fmtTime(s.countedAt)}</div>
        </div>
      </div>
      <button className="btn btn-sm" disabled={refresh.isPending} onClick={() => refresh.mutate(s.itemCode)} aria-label="Refresh stock count">
        {refresh.isPending ? <><span className="spin">↻</span> Refreshing</> : '↻ Refresh'}
      </button>
    </div>
  );
}

function StockStrip({ q }: { q: QuoteDetail }) {
  const o = q.deliveryOffer!;
  return (
    <div className="mt-5 grid grid-cols-3 rounded-lg border border-zinc-200 divide-x divide-zinc-200">
      <div className="p-3">
        <div className="note">In stock now</div>
        <div className="text-lg font-semibold text-red-800">{num(o.availableNow)}</div>
        <div className="note">{q.item?.location}{q.stock ? ` · counted ${fmtTime(q.stock.countedAt)}` : ''}</div>
      </div>
      <div className="p-3">
        <div className="note">Arriving</div>
        <div className="text-lg font-semibold">{o.po ? `${num(o.po.quantity)} on ${fmtDate(o.po.arrivesOn)}` : '—'}</div>
        {o.po ? <div className="note">{o.po.id} · supplier TAT {o.po.supplierTatDays} days</div> : null}
      </div>
      <div className="p-3">
        <div className="note">Ready to ship</div>
        <div className="text-lg font-semibold">{o.readyOn ? fmtDate(o.readyOn) : '—'}</div>
        <div className="note">{o.handlingDays} days to check and pack</div>
      </div>
    </div>
  );
}

function OptionCard({ o, q, checked, onPick }: { o: DeliveryOption; q: QuoteDetail; checked: boolean; onPick: () => void }) {
  const stockPart = o.parts.find((p) => p.source === 'stock');
  const poDay = q.deliveryOffer?.po ? fmtDate(q.deliveryOffer.po.arrivesOn) : '';
  return (
    <label className="opt">
      <input type="radio" name={`d-${q.rfqId}`} value={o.id} checked={checked} onChange={onPick} />
      <div className="font-semibold">{o.id === 'split' ? 'Split delivery' : 'One delivery'}</div>
      <div className="mt-1">{o.id === 'split' ? o.parts.map((p) => `${num(p.quantity)} on ${fmtDate(p.on)}`).join(' · ') : optionText(o)}</div>
      <div className="note">{o.id === 'split' ? `Uses the ${num(stockPart?.quantity ?? 0)} in stock now` : `Waits for the ${poDay} stock`}</div>
    </label>
  );
}

const TRADE_NAME = { quantity: 'quantity tier', later_date: 'later delivery', fast_payment: 'faster payment' } as const;

function Checks({ q, now }: { q: QuoteDetail; now: number }) {
  const acc = q.account.name;
  const possessive = acc.endsWith('s') ? `${acc}'` : `${acc}'s`;
  const verified = {
    mail: `Email matches ${possessive} registered address.`,
    chat: `Signed in as ${acc}.`,
    api: `API key belongs to ${acc}.`,
    phone: `Logged by ${q.salesRep}. The quote goes to ${possessive} registered email.`,
  }[q.channel];
  const p = q.price!;
  const s = q.stock;
  const hold = q.hold;
  let bad = false;
  let stock: React.ReactNode;
  switch (q.stage) {
    case 'ready': {
      if (q.holdLimited) {
        bad = true;
        stock = <><b>Stock not reserved.</b> {q.holdLimited === 'HOLD_LIMIT' ? 'This buyer already holds its limit.' : 'This buyer is not in good standing.'} The quote goes as indicative.</>;
        break;
      }
      const left = hold ? Math.max(0, minutesLeft(hold.expiresAt, now)) : 0;
      stock = <><b>Stock reserved until {hold ? fmtTime(hold.expiresAt) : ''}.</b> {left} min left. {num(hold?.quantity ?? q.quantity ?? 0)} of {num(s?.onHand ?? 0)} units at {s?.location}.</>;
      break;
    }
    case 'stale': bad = true; stock = <><b>Stock data is old.</b> It needs confirming.</>; break;
    case 'with_inventory': bad = true; stock = <><b>Stock data is old.</b> Waiting for Operations.</>; break;
    case 'hold_expired':
    case 'quote_expired': bad = true; stock = <><b>Stock no longer reserved.</b> The 10-minute reservation ran out.</>; break;
    case 'sent': stock = <><b>Stock confirmed.</b> {num(q.quantity ?? 0)} units allotted to this order.</>; break;
    case 'ordered': stock = <><b>{num(q.quantity ?? 0)} units moved to the order.</b> Delivery {deliveryText(q)}.</>; break;
  }
  return (
    <div className="mt-5 border-t border-zinc-200 pt-3">
      <div className="check"><span className="ico" aria-hidden="true">✓</span><div><b>Customer verified.</b> {verified}</div></div>
      <div className="check"><span className="ico" aria-hidden="true">✓</span><div><b>Price OK.</b> Contract price {money(p.contractPrice)}, cost {money(p.unitCost)}.{p.trades.length ? ` Less ${p.trades.map((t) => TRADE_NAME[t.kind]).join(', ')}: ${money(p.basePrice)}.` : ''}</div></div>
      <div className={`check ${bad ? 'bad' : ''}`}><span className="ico" aria-hidden="true">{bad ? '!' : '✓'}</span><div>{stock}</div></div>
    </div>
  );
}

function LossCells({ q, onTag }: { q: QuoteDetail; onTag: (r: LossReason) => void }) {
  const reason = q.loss?.reason ?? null;
  const quoted = q.sent?.unitPrice ?? q.price?.unitPrice ?? null;
  const contract = q.price?.contractPrice ?? null;
  const priceIssue = reason === 'price' || reason === 'competitor';
  return (
    <div className="mt-5 grid grid-cols-3 rounded-lg border border-zinc-200 divide-x divide-zinc-200">
      <div className="p-3">
        <div className="note">Loss reason</div>
        {reason ? (
          <div className="font-semibold">{LOSS_LABEL[reason]}</div>
        ) : q.actions.includes('tag_loss') ? (
          <select className="input !min-h-0 !py-1 mt-1" aria-label="Loss reason" value="" onChange={(e) => e.target.value && onTag(e.target.value as LossReason)}>
            <option value="" disabled>Choose</option>
            {(Object.keys(LOSS_LABEL) as LossReason[]).map((r) => <option key={r} value={r}>{LOSS_LABEL[r]}</option>)}
          </select>
        ) : null}
      </div>
      <div className="p-3">
        <div className="note">Price</div>
        <div className="font-semibold">{priceIssue ? 'Too high for them' : 'Not the issue'}</div>
        {quoted != null ? <div className="note">{quoted === contract ? 'Quoted at contract price' : `Quoted at ${money(quoted)}`}</div> : null}
      </div>
      <div className="p-3">
        <div className="note">Counts in</div>
        <div className="font-semibold">Win-rate report</div>
        {reason ? <div className="note">{LOSS_COUNTS[reason]}</div> : null}
      </div>
    </div>
  );
}

function ReopenForm({ q, onSend, pending }: { q: QuoteDetail; onSend: (a: SalesAction) => void; pending: boolean }) {
  const p = q.price!;
  const opts: DeliveryOption[] = q.deliveryOptions.length
    ? [...q.deliveryOptions].sort((a, b) => (a.id === 'full' ? -1 : b.id === 'full' ? 1 : 0))
    : q.delivery ? [{ ...q.delivery, id: 'stock' }] : [];
  const [optId, setOptId] = useState(opts[0]?.id ?? 'stock');
  const small = q.usage.smallOrder;
  const locked = q.priceLocked ?? q.sent?.unitPrice ?? null;
  const frozen = q.frozen;
  // L1: a small order or a frozen group opens on the price that stands. Otherwise the minimum rounded up
  // to the next 10, plus one step of 10: ₹1,440 for Kaveri (minimum ₹1,429).
  const start = frozen ? Math.max(p.contractPrice, locked ?? 0) : small && locked != null ? locked : Math.ceil(p.minPrice / 10) * 10 + 10;
  const [price, setPrice] = useState(String(start));
  const [reason, setReason] = useState('');
  const qty = q.quantity ?? 0;
  const v = Math.round(Number(price));
  const valid = Number.isFinite(v) && v > 0 && price.trim() !== '';
  const opt = opts.find((o) => o.id === optId) ?? opts[0];
  const win = useWinRate(q.rfqId, valid ? v : null);
  const toFinance = valid && !small && (v < p.minPrice || (locked != null && v < locked));
  let tag: React.ReactNode = null;
  let label = 'Enter a price';
  let disabled = true;
  if (valid) {
    // The same order of checks as the API (ABOVE_CONTRACT, FROZEN, SMALL_ORDER_MIN, PRICE_LOCKED): a refused price never shows an enabled button.
    if (v > Math.max(p.contractPrice, small ? p.minPrice : 0)) { tag = <Tag tone="red">Not allowed</Tag>; label = `Above the contract price ${money(p.contractPrice)}`; }
    else if (frozen && v < Math.max(p.contractPrice, locked != null && small ? locked : 0)) { tag = <Tag tone="red">Not allowed</Tag>; label = 'Discounts are frozen for this buyer: contract price only'; }
    else if (small && locked != null && v < locked) { tag = <Tag tone="red">Not allowed</Tag>; label = 'Small order: the sent price stands'; }
    else if (v < p.minPrice && small) { tag = <Tag tone="red">Not allowed</Tag>; label = `Small order: lowest is ${money(p.minPrice)}`; }
    else if (toFinance) { tag = <Tag tone="amber">Needs Finance</Tag>; label = `Send to Finance: ${money(v)} each`; disabled = reason.trim().length < 3; }
    else {
      tag = <Tag tone="green">Within your limit</Tag>;
      const how = opt?.id === 'split' ? 'split delivery' : opt?.id === 'full' ? `all on ${fmtDate(opt.parts[0].on)}` : deliveryText(q);
      label = `Send new offer: ${money(v)}, ${how}`;
      disabled = false;
    }
  }
  const first = q.firstUnitPrice ?? p.contractPrice;
  const less = (first - v) * qty;
  return (
    <div className="mt-5 rounded-lg border border-zinc-300 p-5">
      <div className="font-semibold text-lg mb-3">New offer for {q.account.name}</div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className="lbl" htmlFor="ko-d">Delivery</label>
          <select id="ko-d" className="input" value={optId} onChange={(e) => setOptId(e.target.value as DeliveryOption['id'])}>
            {opts.map((o) => <option key={o.id} value={o.id}>{o.id === 'stock' ? deliveryText(q) : optionText(o)}</option>)}
          </select>
        </div>
        <div>
          <label className="lbl" htmlFor="ko-p">Price each</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 font-semibold">₹</span>
            <input id="ko-p" type="number" className="input !pl-7 font-semibold" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
        </div>
      </div>
      <div className="mt-3 text-sm">
        {valid ? (
          <>
            {tag}
            <span className="ml-2">
              Total {money(v * qty)} · Margin {(((v - p.unitCost) / v) * 100).toFixed(1)}% · {money((v - p.unitCost) * qty)} profit
              {less > 0 ? ` · ${money(less)} less than the first quote` : ''}
            </span>
          </>
        ) : null}
      </div>
      {valid && !small ? <WinLine w={win.data} className="mt-1" /> : null}
      {toFinance ? (
        <div className="mt-3">
          <label className="lbl" htmlFor="ko-r">Reason for Finance</label>
          <input id="ko-r" className="input" placeholder={`e.g. Wants all on ${opt?.parts[0] ? fmtDate(opt.parts[0].on) : 'the later date'}; keeps the account`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      ) : null}
      <button className="btn btn-go btn-lg mt-4" disabled={disabled || pending}
        onClick={() => onSend({ type: 'reopen', unitPrice: v, delivery: (opt?.id ?? 'stock') as 'stock' | 'split' | 'full', ...(toFinance && reason.trim() ? { reason: reason.trim() } : {}) })}>
        {label}
      </button>
    </div>
  );
}

const STEP_COLOR = { agent: '#2563eb', code: '#16a34a', human: '#d97706', timer: '#52525b' } as const;

function Technical({ q, po }: { q: QuoteDetail; po: boolean }) {
  const t = q.technical;
  const o = q.deliveryOffer;
  return (
    <TechnicalDetails>
      {po && o ? (
        <div className="text-sm mt-2 space-y-1 mb-4">
          <TechRow label="Stock check">code · {num(o.availableNow)} available of {num(q.quantity ?? 0)} needed → short</TechRow>
          <TechRow label="Cost to run"><CostText u={q.usage} /> · AI budget <BudgetText u={q.usage} /></TechRow>
          {o.po && o.readyOn ? (
            <TechRow label="Lead time">
              {o.po.id} due {fmtDate(o.po.arrivesOn)} (supplier TAT {o.po.supplierTatDays} days) + {o.handlingDays} days handling → {fmtDate(o.readyOn)}
            </TechRow>
          ) : null}
          {o.po && q.deliveryOptions.some((x) => x.id === 'split') ? (
            <TechRow label="On send">
              reserves {num(o.availableNow)} now and {num((q.quantity ?? 0) - o.availableNow)} against {o.po.id}
            </TechRow>
          ) : null}
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm mt-2 mb-4">
          <TechRow label="Workflow"><span className="font-mono">{q.workflowId}</span></TechRow>
          {t.holdExpiresAt ? <TechRow label="Hold expiry">{fmtTime(t.holdExpiresAt)} (durable timer)</TechRow> : null}
          <TechRow label="Model">{t.model ?? 'not configured'}</TechRow>
          <TechRow label="Price policy">{t.policyVersion}</TechRow>
          {t.stockReadAt ? <TechRow label="Stock data read">{fmtTime(t.stockReadAt)}</TechRow> : null}
          <TechRow label="Recheck">every fact, at issue</TechRow>
          <TechRow label="Cost to run"><CostText u={q.usage} /></TechRow>
          <TechRow label="AI budget"><BudgetText u={q.usage} /></TechRow>
        </div>
      )}
      {q.trace.length ? (
        <>
          <div className="font-semibold text-sm mb-3">How the agents handled it</div>
          <div className="text-sm">
            {q.trace.map((s, i) => (
              <div key={i} className="step" style={{ ['--c' as string]: STEP_COLOR[s.kind] }}>
                <b>{s.title}</b> <span className="note">· {s.note}</span>
                <div className="text-zinc-600">{s.text}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </TechnicalDetails>
  );
}
