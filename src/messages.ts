import type { DeliveryOption, MessageKind } from './contract';
import { deliveryText, fmtDate, fmtTime, inr, validText } from './domain';

/**
 * Customer messages (DESIGN.md section 9). Every outbound message is built here by code from
 * buyer-safe fields: no cost, margin, thresholds or other accounts can reach a customer. The only
 * model text a customer can receive is a clarification question that passed its post-check.
 */

export interface Mail {
  from: string;
  subject: string;
  paragraphs: string[];
  rows: { label: string; value: string; strong?: boolean }[];
}

export interface Outbound {
  kind: MessageKind;
  mail: Mail | null;
  chat: string | null;
  text: string; // plain text for the audit trail and the API
}

export const SENDER = 'quotes@dhruva.example';

/** Every customer-visible string of a message, for the outbound scan (guardrails.outboundProblem). */
export const messageText = (m: Outbound): string =>
  [m.text, m.chat ?? '', m.mail?.subject ?? '', ...(m.mail?.paragraphs ?? []), ...(m.mail?.rows ?? []).map((r) => `${r.label} ${r.value}`)].join('\n');

/** Figures inside catalogue text ("25mm bearing"): names, allowed in a message about that item. */
export const figuresIn = (text: string): number[] => (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);

const out = (kind: MessageKind, subject: string, paragraphs: string[], chat: string, rows: Mail['rows'] = []): Outbound => ({
  kind,
  mail: { from: SENDER, subject, paragraphs, rows },
  chat,
  text: paragraphs.join('\n'),
});

export type QuestionTopic = 'part' | 'quantity' | 'account' | 'sales';
const QUESTION_SUBJECT: Record<QuestionTopic, string> = {
  part: 'Which part do you need?',
  quantity: 'How many do you need?',
  account: 'Please confirm your account',
  sales: 'A question about your request',
};

export const questionMessage = (topic: QuestionTopic, question: string) => out('question', QUESTION_SUBJECT[topic], [question], question);

export const ackStock = (q: number, item: string) => {
  const t = `Your quote for ${q} × ${item} is with our sales team.`;
  return out('ack', 'We received your request', [t], t);
};

/** The one acknowledgement for every request that names a price, whatever its band. It does not repeat the asked price. */
export const ackFinance = (q: number, item: string) => {
  const t = `Your request for ${q} × ${item} is with our team. We'll reply today.`;
  return out('ack', 'We received your request', [t], t);
};

export interface ShortFacts {
  quantity: number;
  item: string;
  requestedDate: string | null; // IsoDate
  availableNow: number;
  po: { quantity: number; arrivesOn: string } | null;
  readyOn: string | null;
  stockDate: string; // date for the on-hand part
  split: boolean;
}

export function ackShort(f: ShortFacts): Outbound {
  const date = fmtDate(f.requestedDate ?? f.stockDate);
  const mail = `We're checking stock for ${f.quantity} × ${f.item} for delivery by ${date} and will send a quote shortly.`;
  let chat: string;
  if (!f.po || !f.readyOn) chat = `We don't have enough stock for ${f.quantity} × ${f.item} right now. Sales will reply shortly.`;
  else {
    const ready = fmtDate(f.readyOn);
    const split = f.split ? `We can deliver ${f.availableNow} on ${fmtDate(f.stockDate)} and ${f.quantity - f.availableNow} on ${ready}, or all ${f.quantity} on ${ready}.` : `We can deliver all ${f.quantity} on ${ready}.`;
    chat = `We have ${f.availableNow} in stock now and ${f.po.quantity} arriving on ${fmtDate(f.po.arrivesOn)}. ${split} Sales will send the quote.`;
  }
  return out('ack', 'We received your request', [mail], chat);
}

export interface QuoteFacts {
  quoteRef: string;
  revision: number;
  itemCode: string;
  description: string;
  quantity: number;
  unitPrice: number;
  firm: boolean;
  delivery: DeliveryOption;
  place: string | null;
  validUntil: number;
  now: number;
  /** H1: a faster-payment trade is part of the price: the quote states the payment days. */
  paymentDays?: number | null;
}

export function quoteMessage(f: QuoteFacts): Outbound {
  const total = f.unitPrice * f.quantity;
  const delivery = deliveryText(f.delivery, f.place);
  const valid = validText(f.validUntil, f.now);
  const INDICATIVE = 'Indicative: stock is not reserved. Price and availability are confirmed on order.';
  const paragraphs = f.firm ? [] : [INDICATIVE];
  const rows = [
    { label: 'Item', value: `${f.description} (${f.itemCode})` },
    { label: 'Quantity', value: String(f.quantity) },
    { label: 'Price', value: `${inr(f.unitPrice)} each` },
    { label: 'Total', value: inr(total), strong: true },
    { label: 'Delivery', value: delivery },
    ...(f.paymentDays != null ? [{ label: 'Payment', value: f.paymentDays === 0 ? 'in advance' : `within ${f.paymentDays} days of invoice` }] : []),
    { label: 'Valid until', value: valid },
  ];
  const subject = `${f.revision > 1 ? 'Revised quote' : 'Quote'} ${f.quoteRef}`;
  const pay = f.paymentDays != null ? ` Payment ${f.paymentDays === 0 ? 'in advance' : `within ${f.paymentDays} days`}.` : '';
  const chat = `${f.firm ? '' : 'Indicative quote. Stock is not reserved. '}Quote ${f.quoteRef}: ${f.quantity} × ${f.itemCode} at ${inr(f.unitPrice)} each, total ${inr(total)}. Delivery ${delivery}.${pay} Valid until ${valid}.`;
  return { kind: 'quote', mail: { from: SENDER, subject, paragraphs, rows }, chat, text: chat };
}

export function orderConfirmed(f: { orderRef: string; quantity: number; itemCode: string; description: string; unitPrice: number; delivery: DeliveryOption; place: string | null; termsDays: number }): Outbound {
  const total = inr(f.unitPrice * f.quantity);
  const delivery = deliveryText(f.delivery, f.place);
  return out(
    'order_confirmed',
    `Order confirmed: ${f.orderRef}`,
    [
      `We have your order for ${f.quantity} × ${f.itemCode} (${f.description}) at ${inr(f.unitPrice)} each, total ${total}.`,
      `Delivery: ${delivery}. Invoice follows on dispatch, payable ${f.termsDays === 0 ? 'in advance' : `in ${f.termsDays} days`}.`,
    ],
    `Order confirmed: ${f.orderRef}. ${f.quantity} × ${f.itemCode} at ${inr(f.unitPrice)} each, total ${total}. Delivery ${delivery}.`,
  );
}

/** A3: after a partial cancellation, the order's new quantity and price. */
export function orderChanged(f: { orderRef: string; quantity: number; itemCode: string; unitPrice: number }): Outbound {
  const total = inr(f.unitPrice * f.quantity);
  return out(
    'order_confirmed',
    `Order changed: ${f.orderRef}`,
    [`Your order is now ${f.quantity} × ${f.itemCode} at ${inr(f.unitPrice)} each, total ${total}. The price is the one for the smaller quantity.`],
    `Order changed: ${f.orderRef}. ${f.quantity} × ${f.itemCode} at ${inr(f.unitPrice)} each, total ${total}.`,
  );
}

export function quoteExpired(quoteRef: string, validUntil: number): Outbound {
  const t = `The quote was valid until ${fmtTime(validUntil)}, so we couldn't book the order. Our sales team will send a new quote with current stock and price shortly.`;
  return out('quote_expired', `Quote ${quoteRef} has expired`, [t], t);
}

/** A2: the buyer accepted an indicative quote and stock still cannot be reserved for it. */
export function acceptOnHold(quoteRef: string): Outbound {
  const t = `Thank you for accepting quote ${quoteRef}. We could not reserve stock for this order yet, so it is not booked. Our sales team will contact you.`;
  return out('ack', `Re: Quote ${quoteRef}`, [t], t);
}

export function lostAck(quoteRef: string, poArrivesOn: string | null): Outbound {
  const t = `We've closed this quote and released the stock.${poArrivesOn ? ` If the ${fmtDate(poArrivesOn)} delivery arrives early, we'll tell you.` : ''}`;
  return out('lost_ack', `Re: Quote ${quoteRef}`, [t], t);
}

/**
 * The one reply when a price request ends without a discount: Finance said no, or nobody could
 * approve it. It names one price, the standing one, and never the asked price, a reason or a distance,
 * so a refused ask below the max discount and one Finance declined read the same.
 */
export function priceRefused(f: { itemCode: string; unitPrice: number; quantity: number }): Outbound {
  const t = `We can't offer the price you asked for ${f.itemCode}. Our price is ${inr(f.unitPrice)} each (${inr(f.unitPrice * f.quantity)} for ${f.quantity}).`;
  return out('price_refused', 'About your price request', [t], t);
}

/**
 * The one reply to every counter-offer and rival claim (DECISIONS 11, H1). Byte-identical whatever the
 * counter, the claim or the alert level: it names only the price already offered, never a reason, a
 * distance, a floor or a range. It names the trades that can change a price, with no figures: the
 * buyer sends a new request with the trade and gets one new price for it.
 */
export const COUNTER_TRADES = 'A different price needs a different order: a larger quantity, a later delivery date or faster payment. Send a new request with the change and we will quote it.';
export function counterReply(f: { quoteRef: string; unitPrice: number }): Outbound {
  const t = `We can't change this price. Our offer stands at ${inr(f.unitPrice)}. ${COUNTER_TRADES}`;
  return out('counter_reply', `Re: ${f.quoteRef}`, [t], t);
}
