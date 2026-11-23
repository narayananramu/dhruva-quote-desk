// Plain-language names for the Finance case's fact ids (src/agents/grounding.ts FINANCE_FACTS).
import type { Fact, WinRateView } from '@/api/contract';
import { money, num } from './format';

type Kind = 'money' | 'pct' | 'days' | 'count' | 'text' | 'bool';
const L: Record<string, [string, Kind]> = {
  'account.name': ['Customer', 'text'],
  'item.code': ['Item', 'text'],
  'quote.quantity': ['Quantity', 'count'],
  'request.by': ['Asked by', 'text'],
  'request.reason': ['Reason given', 'text'],
  'price.requested': ['Asked price', 'money'],
  'price.contract': ['Contract price', 'money'],
  'cost.unit': ['Unit cost', 'money'],
  'margin.minimumPct': ['Minimum margin', 'pct'],
  'price.minimum': ['Minimum price', 'money'],
  'discount.maxPct': ['Max discount', 'pct'],
  'price.maxDiscount': ['Max-discount price', 'money'],
  'margin.atRequestedPct': ['Margin at asked price', 'pct'],
  'margin.atContractPct': ['Margin at contract price', 'pct'],
  'total.atRequested': ['Total at asked price', 'money'],
  'total.atContract': ['Total at contract price', 'money'],
  'profit.atRequested': ['Profit at asked price', 'money'],
  'profit.atContract': ['Profit at contract price', 'money'],
  'pastQuotes.atRequested.count': ['Past quotes near asked price', 'count'],
  'pastQuotes.atRequested.won': ['Won near asked price', 'count'],
  'pastQuotes.atContract.count': ['Past quotes near contract price', 'count'],
  'winRate.atRequestedPct': ['Win rate at asked price', 'pct'],
  'winRate.atContractPct': ['Win rate at contract price', 'pct'],
  'winRate.atRequested.lowPct': ['Win rate at asked price, low', 'pct'],
  'winRate.atRequested.highPct': ['Win rate at asked price, high', 'pct'],
  'winRate.atContract.lowPct': ['Win rate at contract price, low', 'pct'],
  'winRate.atContract.highPct': ['Win rate at contract price, high', 'pct'],
  'expectedProfit.atRequested': ['Expected profit at asked price', 'money'],
  'expectedProfit.atContract': ['Expected profit at contract price', 'money'],
  'expectedProfit.atRequested.low': ['Expected profit at asked price, low', 'money'],
  'expectedProfit.atRequested.high': ['Expected profit at asked price, high', 'money'],
  'expectedProfit.atContract.low': ['Expected profit at contract price, low', 'money'],
  'expectedProfit.atContract.high': ['Expected profit at contract price, high', 'money'],
  'history.orders': ['Orders', 'count'],
  'history.lifetimeRevenue': ['Lifetime revenue', 'money'],
  'history.avgPaymentDays': ['Pays in', 'days'],
  'history.termsDays': ['Payment terms', 'days'],
  'history.overdueInvoices': ['Overdue invoices', 'count'],
  'history.discountedOrders': ['Discounted orders', 'count'],
  'policy.newCustomer': ['New customer', 'bool'],
  'policy.orderValue': ['Order value', 'money'],
  'policy.newCustomerOrderThreshold': ['Big-order threshold', 'money'],
  'policy.yearVolumeCommitted': ["Year's volume committed", 'bool'],
  'policy.newCustomerDiscountAllowed': ['New-customer rule allows a discount', 'bool'],
  'claim.rivalPrice': ['Claimed rival price', 'money'],
  'claim.rival': ['Claimed rival', 'text'],
  'claim.status': ['Claim', 'text'],
};

export const isClaimFact = (id: string) => id.startsWith('X');

export function factLabel(f: Fact): string {
  return L[f.key]?.[0] ?? f.key;
}

export function factValue(f: Fact): string {
  const kind = L[f.key]?.[1] ?? 'text';
  const v = f.value;
  if (v === null || v === undefined) return 'unknown';
  if (kind === 'bool' || typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') {
    if (kind === 'money') return money(v);
    if (kind === 'pct') return `${v}%`;
    if (kind === 'days') return `${v} days`;
    return num(v);
  }
  return String(v);
}

export const factText = (f: Fact) => `${factLabel(f)}: ${factValue(f)}`;

/** "52–76%" or null when there are too few past quotes. */
export const winRange = (w: WinRateView | null | undefined) =>
  w && w.enough && w.lowPct != null && w.highPct != null ? `${w.lowPct}–${w.highPct}%` : null;
export const profitRange = (w: WinRateView | null | undefined) =>
  w && w.enough && w.expectedProfit ? `${money(w.expectedProfit.low)}–${money(w.expectedProfit.high)}` : null;
