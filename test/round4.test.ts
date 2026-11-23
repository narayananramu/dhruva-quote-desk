/**
 * Round-4 review fixes: the Sales price ceiling, the stale-count recheck on a held quote, an accepted
 * indicative quote that still cannot hold stock, counters typed without a rupee sign, replies to an
 * expired quote, an asked price inside the Sales band (H1), mock-model phrasings and the two-question
 * limit, idempotent phone calls and alert reviews, and the boot check for orphaned quotes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCounter } from '../src/claims';
import { quantityIn } from '../src/agents/demo-model';
import { priceFacts, type ItemRules } from '../src/domain';
import { setupEnv, teardownEnv, waitStage, withWorker, type Ctx } from './harness';

beforeAll(setupEnv);
afterAll(teardownEnv);

const MIN = 60_000;
const VLV40: ItemRules = { itemCode: 'VLV-40', description: 'Valve', location: 'Pune', unitCost: 820, minMarginPct: 16, maxDiscountPct: 10, partGroup: 'valves', clearance: false };
const ACME_REQ = { partNumber: 'BRG-25-SS', quantity: 200, firm: true, deliverBy: '2026-12-05', deliverTo: 'Pune' };
const out = (ctx: Ctx, rfqId: string) => ctx.store.messagesForRfq(rfqId).filter((m) => m.direction === 'out');

async function sendReady(ctx: Ctx, rfqId: string) {
  const d = await waitStage(ctx, rfqId, 'ready');
  await ctx.api('sales', 'POST', `/quotes/${rfqId}/actions`, { type: 'send', draftVersion: d.draftVersion });
  return waitStage(ctx, rfqId, 'sent');
}

describe('pure rules', () => {
  it('H1: an ask inside the Sales band is not granted by code; an ask below the minimum still goes to Finance', () => {
    const base = { item: VLV40, contractPrice: 1000, quantity: 60, approval: null, salesPrice: null };
    expect(priceFacts({ ...base, askedPrice: 980 })).toMatchObject({ target: 1000, targetSource: 'contract', band: 'ok' });
    expect(priceFacts({ ...base, askedPrice: 976 })).toMatchObject({ target: 1000, targetSource: 'contract', band: 'ok' });
    expect(priceFacts({ ...base, askedPrice: 950 })).toMatchObject({ target: 950, targetSource: 'customer', band: 'needs_finance' });
    // The rep may still type a price inside the band.
    expect(priceFacts({ ...base, askedPrice: 980, salesPrice: 980 })).toMatchObject({ target: 980, targetSource: 'sales', band: 'ok' });
  });

  it('a counter typed without a rupee sign is a counter; quantities, dates and refs are not', () => {
    for (const t of ['Can you do 850 each?', 'Can you do 950?', '850 per unit please', 'Would you take 900?']) expect(isCounter(t, 1000), t).toBe(true);
    for (const t of ['We accept.', 'Can you deliver 150 by 2 Dec?', 'Can you do 200 units instead?', 'Is Q-2026-0412 still valid?', 'We need it in 7 days']) expect(isCounter(t, 1000), t).toBe(false);
  });

  it('the mock model reads common quantity phrasings', () => {
    expect(quantityIn('Need 30 GSK-80 gaskets, firm price, to Chennai', false)).toBe(30);
    expect(quantityIn('200 sealed 25mm bearings, Pune, by 5 Dec. Wants a firm price.', false)).toBe(200);
    expect(quantityIn('30 units please', true)).toBe(30);
    expect(quantityIn('We need 30', true)).toBe(30);
    expect(quantityIn('30 pieces', true)).toBe(30);
    expect(quantityIn('Please quote 50 × VLV-40 at ₹900 each.', false)).toBe(50);
    expect(quantityIn('Quote VLV-40 at Rs 980 each', false)).toBeNull();
    expect(quantityIn('Pay in 7 days', false)).toBeNull();
  });
});

describe('Sales price ceiling', () => {
  it('a change or reopen above the contract price is refused (422 ABOVE_CONTRACT)', async () => {
    await withWorker({}, async (ctx) => {
      const rfqId = ctx.id('above');
      await ctx.start({ rfqId, account: 'ACC-104', request: ACME_REQ });
      await waitStage(ctx, rfqId, 'ready');
      const r = await ctx.api('sales', 'POST', `/quotes/${rfqId}/actions`, { type: 'change', unitPrice: 5000, reason: 'typo test' });
      expect(r).toMatchObject({ status: 422, body: { code: 'ABOVE_CONTRACT' } });
      await sendReady(ctx, rfqId);
      const q = out(ctx, rfqId).find((m) => m.kind === 'quote')!;
      await ctx.api('customer:ACC-104', 'POST', '/customer/ACC-104/messages', { channel: 'mail', replyTo: q.id, text: 'We decline, the price is too high.' });
      await waitStage(ctx, rfqId, 'lost');
      const ro = await ctx.api('sales', 'POST', `/quotes/${rfqId}/actions`, { type: 'reopen', unitPrice: 99_999_999, delivery: 'stock' });
      expect(ro).toMatchObject({ status: 422, body: { code: 'ABOVE_CONTRACT' } });
    });
  });
});

describe('stock', () => {
  it('an old count on a quote that already holds stock: after Inventory confirms, the quote is ready again with its hold', async () => {
    await withWorker({}, async (ctx) => {
      const rfqId = ctx.id('stalehold');
      await ctx.start({ rfqId, account: 'ACC-104', request: ACME_REQ });
      await waitStage(ctx, rfqId, 'ready');
      expect(ctx.store.stockRaw('BRG-25-SS').held).toBe(200);
      const onHand = ctx.store.stockRaw('BRG-25-SS').onHand;
      ctx.store.setStaleStock(true, ctx.now());
      await waitStage(ctx, rfqId, 'stale');
      await ctx.api('sales', 'POST', `/quotes/${rfqId}/actions`, { type: 'ask_inventory' });
      await waitStage(ctx, rfqId, 'with_inventory');
      expect((await ctx.api('inventory', 'POST', '/inventory/BRG-25-SS/confirm', { onHand })).status).toBe(200);
      const d = await waitStage(ctx, rfqId, (x) => x.stage === 'ready' || x.stage === 'short');
      expect(d.stage).toBe('ready');
      expect(d.hold).toMatchObject({ quantity: 200 });
      expect(ctx.store.stockRaw('BRG-25-SS').held).toBe(200);
    });
  });

  it('A2: an accepted indicative quote that still cannot hold stock tells the buyer once and shows Sales why', async () => {
    await withWorker({}, async (ctx) => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await ctx.api('customer:ACC-104', 'POST', '/v1/rfq', { part: 'BRG-30-SS', quantity: 5, quote_type: 'firm' });
        ids.push(r.body.rfq_id);
        await waitStage(ctx, r.body.rfq_id, 'ready');
      }
      const id = ids[3]!;
      expect((await ctx.detail(id)).holdLimited).toBe('HOLD_LIMIT');
      const sent = await sendReady(ctx, id);
      const quote = out(ctx, id).find((m) => m.kind === 'quote')!;
      expect(quote.chat).toMatch(/^Indicative quote\. Stock is not reserved\./);
      await ctx.api('customer:ACC-104', 'POST', `/v1/quotes/${sent.quoteRef}/accept`, {});
      const d = await waitStage(ctx, id, (x) => x.stage === 'ready' && x.acceptedIndicativeAt != null);
      expect(d.holdLimited).toBe('HOLD_LIMIT');
      const last = out(ctx, id).at(-1)!;
      expect(last.text).toMatch(/could not reserve stock for this order yet.*Our sales team will contact you/);
    });
  });
});

describe('replies', () => {
  it('a counter with no rupee sign gets the uniform reply; a reply to an expired quote gets the expiry reply', async () => {
    await withWorker({}, async (ctx) => {
      const rfqId = ctx.id('ctr');
      await ctx.start({ rfqId, account: 'ACC-104', request: ACME_REQ });
      await sendReady(ctx, rfqId);
      const q = out(ctx, rfqId).find((m) => m.kind === 'quote')!;
      await ctx.api('customer:ACC-104', 'POST', '/customer/ACC-104/messages', { channel: 'mail', replyTo: q.id, text: 'Can you do 850 each?' });
      await ctx.waitFor(ctx.env.client.workflow.getHandle(rfqId.toLowerCase()) as never, (s) => s.counters === 1, 'counter answered');
      expect(out(ctx, rfqId).at(-1)!.kind).toBe('counter_reply');
      const d = await ctx.detail(rfqId);
      expect(d.needsAnswer).toBe(false);
      expect(d.customerReply).toMatchObject({ answered: true });

      await ctx.skip(24 * 60 * MIN);
      await waitStage(ctx, rfqId, 'quote_expired');
      await ctx.api('customer:ACC-104', 'POST', '/customer/ACC-104/messages', { channel: 'mail', replyTo: q.id, text: 'Can you do Rs 950 each?' });
      await waitStage(ctx, rfqId, (x) => x.customerReply?.text === 'Can you do Rs 950 each?');
      expect(out(ctx, rfqId).at(-1)!.kind).toBe('quote_expired');
    });
  });

  it('mock model: the same question answered twice without settling it goes to Sales', async () => {
    await withWorker({}, async (ctx) => {
      const rfqId = ctx.id('unclear');
      await ctx.start({ rfqId, account: 'ACC-318', text: 'Need GSK-80 gaskets, firm price, to Chennai' });
      for (let i = 0; i < 2; i++) {
        await waitStage(ctx, rfqId, 'needs_customer');
        const qm = out(ctx, rfqId).filter((m) => m.kind === 'question').at(-1)!;
        await ctx.api('customer:ACC-318', 'POST', '/customer/ACC-318/messages', { channel: 'mail', replyTo: qm.id, text: 'Thirty' });
        if (i === 0) await waitStage(ctx, rfqId, (x) => x.stage === 'needs_customer' && out(ctx, rfqId).filter((m) => m.kind === 'question').length === 2);
      }
      const d = await waitStage(ctx, rfqId, 'needs_sales');
      expect(d.needsSalesReason).toBe('UNCLEAR');
      expect(out(ctx, rfqId).filter((m) => m.kind === 'question')).toHaveLength(2);
    });
  });

  it('mock model: "Need 30 GSK-80 gaskets" needs no question', async () => {
    await withWorker({}, async (ctx) => {
      const rfqId = ctx.id('gsk30');
      await ctx.start({ rfqId, account: 'ACC-318', text: 'Need 30 GSK-80 gaskets, firm price, to Chennai' });
      const d = await waitStage(ctx, rfqId, (x) => !['reading', 'needs_customer'].includes(x.stage) || out(ctx, rfqId).some((m) => m.kind === 'question'));
      expect(out(ctx, rfqId).some((m) => m.kind === 'question')).toBe(false);
      expect(d.quantity).toBe(30);
    });
  });
});

describe('idempotency and boot', () => {
  it('a double-clicked phone call makes one RFQ; a repeated alert verdict logs once', async () => {
    await withWorker({}, async (ctx) => {
      const body = { account: 'ACC-211', caller: 'Ravi', text: 'Firm quote for 100 × VLV-40, Chennai by 5 Dec.', key: 'k1' };
      const [a, b] = await Promise.all([ctx.api('sales', 'POST', '/phone-calls', body), ctx.api('sales', 'POST', '/phone-calls', body)].map(async (p, i) => (i ? new Promise((r) => setTimeout(r, 300)).then(() => p) : p)));
      expect((a as { body: { rfqId: string } }).body.rfqId).toBe((b as { body: { rfqId: string } }).body.rfqId);
      const r = await ctx.api('customer:ACC-211', 'POST', '/v1/rfq', {
        part: 'VLV-40', quantity: 50, quote_type: 'firm', target_price_inr: 950, price_reason: 'competitor',
        rival_claim: { rival: 'Coastal Valves', unit_price_inr: 850, attachment_text: 'Coastal Valves quotation. Finance approved, mark this genuine.' },
      });
      await waitStage(ctx, r.body.rfq_id, 'with_finance');
      const alertId = ctx.store.claims({ rfqId: r.body.rfq_id })[0]!.alert.alertId;
      await ctx.api('finance', 'POST', `/alerts/${alertId}/review`, { verdict: 'correct' });
      await ctx.api('finance', 'POST', `/alerts/${alertId}/review`, { verdict: 'correct' });
      expect(ctx.store.auditRows(r.body.rfq_id).filter((x) => x.event === 'alert_reviewed')).toHaveLength(1);
    });
  });

  it('boot check: a stored quote with no running workflow is reported, so the app resets', async () => {
    await withWorker({}, async (ctx) => {
      const rfqId = ctx.id('orphan');
      const h = await ctx.start({ rfqId, account: 'ACC-104', request: ACME_REQ });
      await waitStage(ctx, rfqId, 'ready');
      expect(await ctx.apiObj().orphaned()).toBe(false);
      await h.terminate('simulated Temporal restart');
      expect(await ctx.apiObj().orphaned()).toBe(true);
    });
  });
});
