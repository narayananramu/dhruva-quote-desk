// One query or mutation hook per endpoint (docs/DESIGN.md 8.3, 10.3).
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, clockNow, onClock } from './client';
import type {
  AgentInfo,
  AlertMetrics,
  ClaimView,
  WinRateView,
  AiCallRow,
  AuditRow,
  CustomerHistory,
  CustomerMessage,
  Account,
  DebitNote,
  RepReportRow,
  FinanceCase,
  FinanceDecision,
  QuoteDetail,
  QuoteSummary,
  ReservationRow,
  SalesAction,
  Session,
  Settings,
  StockRequest,
  StockRow,
  UsageView,
} from './contract';

const POLL = 2000;
const poll = { refetchInterval: POLL, refetchIntervalInBackground: false } as const;

// ---- clock ----
/** Demo clock: last server `now` plus time elapsed; re-renders every second. */
export function useNow(): number {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 1000);
    const off = onClock(() => force((x) => x + 1));
    return () => {
      clearInterval(t);
      off();
    };
  }, []);
  return clockNow() ?? Date.now();
}

function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

// ---- session ----
export const useSession = (enabled: boolean) =>
  useQuery({ queryKey: ['session'], queryFn: () => api<Session>('GET', '/session'), enabled, staleTime: 60_000 });
export const useLogin = () =>
  useMutation({ mutationFn: (code?: string) => api<Session>('POST', '/session', code ? { code } : {}) });

// ---- sales ----
export const useQuotes = () =>
  useQuery({ queryKey: ['quotes'], queryFn: () => api<{ now: number; quotes: QuoteSummary[] }>('GET', '/quotes'), ...poll });

export const useQuote = (rfqId: string | undefined) =>
  useQuery({
    queryKey: ['quote', rfqId],
    queryFn: () => api<{ now: number; quote: QuoteDetail }>('GET', `/quotes/${rfqId}`),
    enabled: !!rfqId,
    refetchInterval: (q) => (q.state.data?.quote.stage === 'reading' ? 700 : POLL),
    refetchIntervalInBackground: false,
  });

export function useSalesAction(rfqId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: SalesAction) =>
      api<{ now: number; quote: QuoteDetail; settled: boolean }>('POST', `/quotes/${rfqId}/actions`, a),
    onSuccess: (d) => {
      qc.setQueryData(['quote', rfqId], { now: d.now, quote: d.quote });
      qc.invalidateQueries();
    },
  });
}

export function usePhoneCall() {
  const inv = useInvalidateAll();
  return useMutation({
    mutationFn: (b: { account: string; caller: string; text: string; key?: string }) =>
      api<{ rfqId: string; quoteRef: string }>('POST', '/phone-calls', b),
    onSuccess: inv,
  });
}

export function useRefreshStock() {
  const inv = useInvalidateAll();
  return useMutation({
    mutationFn: (itemCode: string) => api<{ now: number; item: StockRow }>('POST', `/inventory/${itemCode}/refresh`),
    onSuccess: inv,
  });
}

/** Win rate and expected gross profit at a typed price (reopen form, Finance's other price). */
export function useWinRate(rfqId: string, price: number | null) {
  const [p, setP] = useState(price);
  useEffect(() => {
    const t = setTimeout(() => setP(price), 250);
    return () => clearTimeout(t);
  }, [price]);
  const ok = p != null && Number.isInteger(p) && p > 0;
  return useQuery({
    queryKey: ['win-rate', rfqId, p],
    queryFn: () => api<{ now: number; winRate: WinRateView }>('GET', `/quotes/${rfqId}/win-rate?price=${p}`),
    enabled: ok,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
    select: (d) => d.winRate,
  });
}

// ---- finance ----
export const useFinanceQueue = () =>
  useQuery({
    queryKey: ['finance'],
    queryFn: () => api<{ now: number; cases: FinanceCase[] }>('GET', '/finance/queue'),
    ...poll,
  });

export function useFinanceDecision(rfqId: string) {
  const inv = useInvalidateAll();
  return useMutation({
    mutationFn: (d: FinanceDecision) =>
      api<{ now: number; case?: FinanceCase; quote?: QuoteDetail; settled: boolean }>('POST', `/finance/${rfqId}/decision`, d),
    onSuccess: inv,
  });
}

export function useReviewAlert() {
  const inv = useInvalidateAll();
  return useMutation({
    mutationFn: (v: { alertId: string; verdict: 'correct' | 'wrong' }) =>
      api<{ now: number; claim: ClaimView }>('POST', `/alerts/${v.alertId}/review`, { verdict: v.verdict }),
    onSuccess: inv,
  });
}
export function useVerifyClaim() {
  const inv = useInvalidateAll();
  return useMutation({
    mutationFn: (v: { claimId: string; result: 'genuine' | 'fake'; channel: string }) =>
      api<{ now: number; claim: ClaimView }>('POST', `/claims/${v.claimId}/verify`, { result: v.result, channel: v.channel }),
    onSuccess: inv,
  });
}
export const useAlertMetrics = () =>
  useQuery({ queryKey: ['alert-metrics'], queryFn: () => api<{ now: number; metrics: AlertMetrics }>('GET', '/alerts/metrics'), ...poll });

/** A3: booked orders (GET /orders), for recording when the buyer paid. */
export interface OrderRow {
  orderRef: string; account: string; itemCode: string; quantity: number; unitPrice: number; orderedOn: string;
  paidDays: number | null; termsDays: number | null; conditions: { kind: string; required: number; status: string }[];
}
export const useOrders = () =>
  useQuery({ queryKey: ['orders'], queryFn: () => api<{ now: number; orders: OrderRow[] }>('GET', '/orders'), ...poll });
export function useRecordPayment() {
  const inv = useInvalidateAll();
  return useMutation({
    mutationFn: (v: { orderRef: string; paidDays: number }) => api<{ now: number; debitNotes: DebitNote[] }>('POST', `/orders/${v.orderRef}/payment`, { paidDays: v.paidDays }),
    onSuccess: inv,
  });
}

export const useDebitNotes = () =>
  useQuery({ queryKey: ['debit-notes'], queryFn: () => api<{ now: number; debitNotes: DebitNote[] }>('GET', '/finance/debit-notes'), ...poll });
export const useRepReport = () =>
  useQuery({ queryKey: ['reps'], queryFn: () => api<{ now: number; reps: RepReportRow[] }>('GET', '/finance/reps'), ...poll });

export const useHistory = (account: string) =>
  useQuery({
    queryKey: ['history', account],
    queryFn: () => api<{ now: number; history: CustomerHistory }>('GET', `/customers/${account}/history`),
  });

// ---- inventory ----
export const useInventory = () =>
  useQuery({
    queryKey: ['inventory'],
    queryFn: () =>
      api<{ now: number; items: StockRow[]; requests: StockRequest[]; activeReservations: number }>('GET', '/inventory'),
    ...poll,
  });
export const useReservations = () =>
  useQuery({
    queryKey: ['reservations'],
    queryFn: () => api<{ now: number; reservations: ReservationRow[] }>('GET', '/inventory/reservations'),
    ...poll,
  });
export function useConfirmStock() {
  const inv = useInvalidateAll();
  return useMutation({
    mutationFn: (v: { itemCode: string; onHand: number }) =>
      api<{ now: number; item: StockRow }>('POST', `/inventory/${v.itemCode}/confirm`, { onHand: v.onHand }),
    onSuccess: inv,
  });
}

// ---- customer ----
export const useMessages = (account: string | undefined) =>
  useQuery({
    queryKey: ['messages', account],
    queryFn: () =>
      api<{ now: number; account: Account; messages: CustomerMessage[] }>('GET', `/customer/${account}/messages`),
    enabled: !!account,
    ...poll,
  });
export function usePostMessage(account: string) {
  const inv = useInvalidateAll();
  return useMutation({
    mutationFn: (b: { channel: 'mail' | 'chat'; text: string; subject?: string; replyTo?: string }) =>
      api<{ messageId: string; rfqId: string }>('POST', `/customer/${account}/messages`, b),
    onSuccess: inv,
  });
}

// ---- audit, agents, settings ----
export const useAudit = (rfqId: string | undefined) =>
  useQuery({
    queryKey: ['audit', rfqId],
    queryFn: () =>
      api<{
        now: number;
        quote: { rfqId: string; quoteRef: string; workflowId: string; accountName: string; model: string | null };
        rows: AuditRow[];
        usage: UsageView;
        aiCalls: AiCallRow[];
      }>('GET', `/audit/${rfqId}`),
    enabled: !!rfqId,
    ...poll,
  });

export const useAgents = () =>
  useQuery({ queryKey: ['agents'], queryFn: () => api<{ now: number; agents: AgentInfo[] }>('GET', '/agents') });

export const useSettings = (enabled: boolean) =>
  useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('GET', '/settings'), enabled, ...poll });

export function useSettingsActions() {
  const inv = useInvalidateAll();
  const opts = { onSuccess: inv };
  return {
    advance: useMutation({
      mutationFn: (minutes: number) => api<{ now: number }>('POST', '/settings/clock/advance', { minutes }),
      ...opts,
    }),
    stale: useMutation({ mutationFn: (on: boolean) => api<Settings>('PUT', '/settings/stale-stock', { on }), ...opts }),
    load: useMutation({
      mutationFn: (id: string) =>
        api<{ rfqId: string; quoteRef: string; account: string }>('POST', `/settings/test-requests/${id}/load`),
      ...opts,
    }),
    reset: useMutation({ mutationFn: () => api<Settings>('POST', '/settings/reset'), ...opts }),
  };
}
