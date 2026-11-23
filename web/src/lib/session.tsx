import { createContext, useContext } from 'react';
import type { Session } from '@/api/contract';

export const SessionContext = createContext<Session | null>(null);
export function useSessionValue(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('No session');
  return s;
}

/** The quote last opened in Sales, for the Audit screen's default. */
let lastQuote: string | null = null;
export const setLastQuote = (id: string) => {
  lastQuote = id;
  try { sessionStorage.setItem('dhruva.lastQuote', id); } catch { /* ignore */ }
};
export const getLastQuote = () => {
  if (lastQuote) return lastQuote;
  try { return sessionStorage.getItem('dhruva.lastQuote'); } catch { return null; }
};
