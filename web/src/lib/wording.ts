// Stage → chip, banner and primary button (docs/DESIGN.md 10.4). Strings are the mockup's.
import type { DeliveryOption, LossReason, QuoteDetail, QuoteSummary, SalesAction } from '@/api/contract';
import { fmtDate, fmtTime, leftText, minutesLeft, money, num, paise, whenText } from './format';

export type Tone = 'green' | 'amber' | 'red' | 'gray';
export interface ChipSpec { tone: Tone; icon: string; text: string }
export interface BannerSpec { tone: Tone; lines: string[] }
export interface PrimarySpec { label: string; go: boolean; action: SalesAction | 'reopen_form' }

const firstWord = (s: string) => s.split(' ')[0];

export function chipFor(q: Pick<QuoteSummary, 'stage' | 'revision' | 'needsAnswer'>): ChipSpec {
  switch (q.stage) {
    case 'reading': return { tone: 'gray', icon: '◷', text: 'Reading request' };
    case 'needs_customer': return { tone: 'amber', icon: '◷', text: 'Waiting for customer' };
    case 'ready': return { tone: 'green', icon: '✓', text: 'Ready to send' };
    case 'stale': return { tone: 'amber', icon: '?', text: 'Check stock' };
    case 'with_inventory': return { tone: 'amber', icon: '◷', text: 'With Operations' };
    case 'hold_expired': return { tone: 'gray', icon: '◷', text: 'Expired' };
    case 'short': return { tone: 'red', icon: '!', text: 'Short of stock' };
    case 'with_finance': return { tone: 'amber', icon: '₹', text: 'With Finance' };
    case 'finance_rejected': return { tone: 'red', icon: '!', text: 'Rejected by Finance' };
    case 'blocked': return { tone: 'red', icon: '!', text: 'Below max discount' };
    case 'sent':
      if (q.needsAnswer) return { tone: 'amber', icon: '?', text: 'Needs your answer' };
      return { tone: 'gray', icon: '✓', text: q.revision >= 2 ? 'Sent (revised)' : 'Sent' };
    case 'quote_expired': return { tone: 'gray', icon: '◷', text: 'Expired' };
    case 'ordered': return { tone: 'green', icon: '✓', text: 'Order confirmed' };
    case 'lost': return { tone: 'gray', icon: '✕', text: 'Lost' };
    case 'closed': return { tone: 'gray', icon: '◷', text: 'Closed' };
    case 'failed': return { tone: 'red', icon: '!', text: 'Needs attention' };
    case 'needs_sales': return { tone: 'amber', icon: '?', text: 'Needs your answer' };
  }
}

/** "20 on 28 Nov, 100 on 4 Dec" / "All 120 on 4 Dec" */
export function optionText(o: DeliveryOption): string {
  if (o.id === 'full') return `All ${num(o.parts.reduce((s, p) => s + p.quantity, 0))} on ${fmtDate(o.parts[0].on)}`;
  return o.parts.map((p) => `${num(p.quantity)} on ${fmtDate(p.on)}`).join(', ');
}

/** Button text for the short-stock send: "Send quote: 20 now, 100 on 4 Dec" / "Send quote: all 120 on 4 Dec" */
export function shortSendLabel(o: DeliveryOption): string {
  if (o.id === 'full') return `Send quote: all ${num(o.parts.reduce((s, p) => s + p.quantity, 0))} on ${fmtDate(o.parts[0].on)}`;
  const now = o.parts.find((p) => p.source === 'stock');
  const later = o.parts.find((p) => p.source === 'po');
  return `Send quote: ${num(now?.quantity ?? 0)} now, ${num(later?.quantity ?? 0)} on ${later ? fmtDate(later.on) : ''}`;
}

export function deliveryText(q: QuoteDetail): string {
  const d = q.delivery;
  const place = q.wants.deliverTo ?? q.item?.location ?? '';
  if (!d || d.id === 'stock') {
    const on = d?.parts[0]?.on ?? q.wants.deliverBy;
    return [on ? fmtDate(on) : null, place || null].filter(Boolean).join(', ');
  }
  return optionText(d);
}

export function bannerFor(q: QuoteDetail, now: number): BannerSpec | null {
  const acc = q.account.name;
  const hold = q.hold ?? (q.technical.holdExpiresAt ? { expiresAt: q.technical.holdExpiresAt, quantity: q.quantity ?? 0 } : null);
  const replyLine = q.customerReply && q.stage !== 'sent' ? [`Their reply: “${q.customerReply.text}”`] : [];
  const contract = q.price ? money(q.priceLocked ?? q.price.contractPrice) : '';
  switch (q.stage) {
    case 'reading':
    case 'closed':
    case 'failed':
      return null;
    case 'needs_customer':
      return { tone: 'amber', lines: [`Waiting for ${acc} to reply.`] };
    case 'needs_sales': {
      const first = q.needsSalesReason === 'SMALL_ORDER'
        ? 'Small order. Read the request and set the item and quantity, or ask the customer.'
        : q.needsSalesReason === 'UNCLEAR'
        ? 'The customer\'s answers did not settle the request. Read it and set the item and quantity, or ask the customer.'
        : `${q.usage.budgetInr > 0 ? `The AI budget of ${paise(q.usage.budgetInr)}` : 'The AI budget'} for this request is used up. Read the request and set the item and quantity, or ask the customer.`;
      const words = q.customerReply?.text ?? q.requestText;
      return { tone: 'amber', lines: [first, ...(words ? [`Their words: “${words}”`] : [])] };
    }
    case 'ready': {
      if (q.holdLimited) {
        const why = q.holdLimited === 'HOLD_LIMIT' ? 'this buyer already holds its limit' : 'this buyer is not in good standing';
        if (q.acceptedIndicativeAt != null)
          return { tone: 'red', lines: [`${acc} accepted at ${fmtTime(q.acceptedIndicativeAt)}, but stock could not be reserved: ${why}. The order is not booked. Call them.`, ...replyLine] };
        return { tone: 'amber', lines: [`Stock not reserved: ${why}. The quote goes as indicative.`, ...replyLine] };
      }
      if (q.acceptedIndicativeAt != null && hold)
        return { tone: 'green', lines: [`${acc} accepted the indicative quote. Stock is reserved until ${fmtTime(hold.expiresAt)}. Send the firm quote.`, ...replyLine] };
      const until = hold ? fmtTime(hold.expiresAt) : '';
      const left = hold ? Math.max(0, minutesLeft(hold.expiresAt, now)) : 0;
      return { tone: 'green', lines: [`Safe to send. Stock is reserved until ${until}, ${left} min left.`, ...replyLine] };
    }
    case 'stale':
      return { tone: 'red', lines: ['Stock data is old. Ask Operations to confirm stock before sending.', ...replyLine] };
    case 'with_inventory':
      return { tone: 'amber', lines: ['Operations has been asked to confirm stock. You can send once they confirm.', ...replyLine] };
    case 'hold_expired':
      return {
        tone: 'gray',
        lines: [`The stock reservation ended at ${hold ? fmtTime(hold.expiresAt) : ''}. Reserve the stock again, then send.`, ...replyLine],
      };
    case 'short': {
      const off = q.deliveryOffer;
      if (off?.po && off.readyOn) {
        const wanted = off.requestedDate ? fmtDate(off.requestedDate) : 'the date asked';
        return { tone: 'red', lines: [`Not enough stock for ${wanted}. Earliest full delivery is ${fmtDate(off.readyOn)}.`, ...replyLine] };
      }
      return {
        tone: 'red',
        lines: [`Not enough stock: ${num(q.stock?.available ?? off?.availableNow ?? 0)} available, ${num(q.quantity ?? 0)} needed.`, ...replyLine],
      };
    }
    case 'with_finance': {
      const f = q.finance;
      const left = f ? leftText(f.deadlineAt, now) : null;
      const when = f ? whenText(f.deadlineAt, now) : '';
      const due = !f || f.status !== 'waiting' ? [] : left ? [`Finance decides by ${when}, ${left} left.`]
        : f.standingPriceOnly ? [`Finance did not decide by ${when}. The standing price holds.`]
        : [`Finance did not decide by ${when}. You decide on the same figures.`];
      if (q.loss && f?.requestedBy === 'sales')
        return {
          tone: 'amber',
          lines: [`New offer of ${money(f.requestedUnitPrice)} each sent to Finance. If they approve, it goes to ${firstWord(acc)} automatically.`, ...due],
        };
      if (f?.status === 'waiting' && !left) return { tone: 'amber', lines: [...due, ...replyLine] };
      return { tone: 'amber', lines: ['With Finance. If they approve, the quote goes to the customer automatically.', ...due, ...replyLine] };
    }
    case 'finance_rejected':
      return { tone: 'red', lines: [`Finance rejected the discount. Reply to the customer or offer ${contract}.`, ...replyLine] };
    case 'blocked':
      return { tone: 'red', lines: [`The price asked is below the max discount. Reply to the customer or offer ${contract}.`, ...replyLine] };
    case 'sent': {
      if (q.customerReply?.answered)
        return { tone: 'gray', lines: [`${acc} asked for a different price at ${fmtTime(q.customerReply.at)}. They were told the price stands.`, `Their words: “${q.customerReply.text}”`] };
      if (q.customerReply)
        return { tone: 'amber', lines: [`${acc} replied at ${fmtTime(q.customerReply.at)}.`, `Their words: “${q.customerReply.text}”`] };
      const s = q.sent;
      if (!s) return null;
      if (q.revision >= 2) {
        const d = q.delivery;
        const dl =
          d && d.id === 'split'
            ? d.parts.map((p) => `${num(p.quantity)} on ${fmtDate(p.on)}`).join(' and ')
            : d && d.id === 'full'
              ? `all on ${fmtDate(d.parts[0].on)}`
              : deliveryText(q);
        return {
          tone: 'green',
          lines: [`New offer sent at ${fmtTime(s.at)}: ${num(q.quantity ?? 0)} × ${q.itemCode} at ${money(s.unitPrice)} each (${money(s.total)}), ${dl}.`],
        };
      }
      if (q.finance?.status === 'approved' && q.finance.approvedUnitPrice != null && q.finance.decidedByRole === 'sales')
        return { tone: 'green', lines: [`You approved ${money(q.finance.approvedUnitPrice)} each after the Finance deadline. Quote sent to the customer.`] };
      if (q.finance?.status === 'approved' && q.finance.approvedUnitPrice != null)
        return { tone: 'green', lines: [`Finance approved ${money(q.finance.approvedUnitPrice)} each. Quote sent to the customer.`] };
      if (s.fromPo > 0) {
        const from = q.deliveryOffer?.po ? `the ${fmtDate(q.deliveryOffer.po.arrivesOn)} stock` : (s.poId ?? 'incoming stock');
        return {
          tone: 'green',
          lines: [
            s.fromStock > 0
              ? `Quote sent. ${num(s.fromStock)} reserved now; ${num(s.fromPo)} reserved from ${from}.`
              : `Quote sent. ${num(s.fromPo)} reserved from ${from}.`,
          ],
        };
      }
      return { tone: 'green', lines: [`Quote sent to ${s.to} at ${fmtTime(s.at)}.`] };
    }
    case 'quote_expired':
      if (q.lateAcceptAt)
        return {
          tone: 'gray',
          lines: [`${acc} tried to accept at ${fmtTime(q.lateAcceptAt)}, after the quote expired. Reserve stock again and send a new quote.`],
        };
      if (q.customerReply)
        return {
          tone: 'amber',
          lines: [`${acc} replied at ${fmtTime(q.customerReply.at)}, after the quote expired. They were told it expired. Reserve stock again and send a new quote.`, `Their words: “${q.customerReply.text}”`],
        };
      return {
        tone: 'gray',
        lines: [`The quote expired at ${q.sent ? fmtTime(q.sent.validUntil) : ''} with no reply. Reserve stock again and send a new quote.`],
      };
    case 'ordered':
      return { tone: 'green', lines: [`${acc} accepted at ${q.order ? fmtTime(q.order.acceptedAt) : ''}. Order ${q.order?.ref ?? ''} is booked.`] };
    case 'lost': {
      const l = q.loss;
      if (!l) return { tone: 'gray', lines: [`${acc} declined. Quote closed as lost.`] };
      let third = `${num(l.releasedFromStock)} units released.`;
      if (l.poId) third += ` Nothing reserved from ${l.poId}.`;
      return {
        tone: 'gray',
        lines: [`${acc} declined at ${fmtTime(l.declinedAt)}. Quote closed as lost.`, ...(l.customerWords.trim() ? [`Their reason: “${l.customerWords}”`] : []), third],
      };
    }
  }
}

export function primaryFor(q: QuoteDetail, selected: DeliveryOption | null): PrimarySpec | null {
  const has = (a: string) => q.actions.includes(a as never);
  switch (q.stage) {
    case 'ready':
      return has('send') ? { label: 'Send quote to customer', go: true, action: { type: 'send', draftVersion: q.draftVersion } } : null;
    case 'stale':
      return has('ask_inventory') ? { label: 'Ask Operations to confirm stock', go: false, action: { type: 'ask_inventory' } } : null;
    case 'hold_expired':
    case 'quote_expired':
      return has('reserve') ? { label: 'Reserve stock again', go: false, action: { type: 'reserve' } } : null;
    case 'short':
      if (!has('send') || !selected || selected.id === 'stock') return null;
      return { label: shortSendLabel(selected), go: true, action: { type: 'send', draftVersion: q.draftVersion, delivery: selected.id } };
    case 'lost':
      return has('reopen') ? { label: 'Reopen with a new offer', go: false, action: 'reopen_form' } : null;
    case 'finance_rejected':
    case 'blocked': {
      // The standing price: the sent price if one went out, else the contract price.
      if (!has('change') || !q.price) return null;
      const price = q.priceLocked ?? q.price.contractPrice;
      return { label: `Offer ${money(price)}`, go: false, action: { type: 'change', unitPrice: price, reason: q.stage === 'blocked' ? 'Asked price is below the max discount' : 'Finance rejected the discount' } };
    }
    default:
      return null;
  }
}

export const LOSS_LABEL: Record<LossReason, string> = {
  delivery_date: 'Delivery date',
  price: 'Price',
  competitor: 'Competitor',
  specification: 'Specification',
  other: 'Other',
};
export const LOSS_COUNTS: Record<LossReason, string> = {
  delivery_date: 'Lost to lead time',
  price: 'Lost on price',
  competitor: 'Lost to a competitor',
  specification: 'Lost on specification',
  other: 'Lost, other reason',
};
export const PRICE_REASON_TEXT = {
  competitor: 'a competitor offered a lower price.',
  volume: 'they are ordering a large quantity.',
  budget: 'their budget is fixed.',
  other: 'they gave another reason.',
} as const;

export const CHANNEL_WORD = { mail: 'email', chat: 'chat', api: 'API', phone: 'phone' } as const;
