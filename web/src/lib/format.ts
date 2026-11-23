// Formatting in Asia/Kolkata whatever the browser's zone (docs/DESIGN.md 5, 10.1).
const TZ = 'Asia/Kolkata';

const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const secFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' });
const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

export const money = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');
/** Rupees with paise: "₹0.50" */
export const paise = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const num = (n: number) => n.toLocaleString('en-IN');

/** "10:10" */
export const fmtTime = (ms: number) => timeFmt.format(ms);
/** "09:58:02" */
export const fmtTimeSec = (ms: number) => secFmt.format(ms);
/** IsoDate or ms → "5 Dec" */
export function fmtDate(d: string | number): string {
  if (typeof d === 'number') return dayFmt.format(d);
  const [y, m, day] = d.split('-').map(Number);
  return dayFmt.format(Date.UTC(y, m - 1, day, 6));
}
export const ymd = (ms: number) => ymdFmt.format(ms);
export const monthShort = (d: string) => new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(Date.parse(d + 'T06:00:00Z'));

export const pct = (n: number) => `${n.toFixed(1)}%`;
/** 18.0 → "18%", 8.9 → "8.9%" (the mockup drops a trailing .0 in headline figures) */
export const pctShort = (n: number) => `${Number.isInteger(Math.round(n * 10) / 10) ? Math.round(n) : n.toFixed(1)}%`;

export const marginPct = (price: number, cost: number) => ((price - cost) / price) * 100;

export const minutesLeft = (until: number, now: number) => Math.ceil((until - now) / 60000);

/** "10:10 today" / "5 pm today" / "5 pm on 24 Nov" */
export function validText(validUntil: number, now: number): string {
  const sameDay = ymd(validUntil) === ymd(now);
  const t = fmtTime(validUntil);
  const label = t === '17:00' ? '5 pm' : t;
  return sameDay ? `${label} today` : `${label} on ${fmtDate(validUntil)}`;
}

/** "14:30" today, else "14:30 on 24 Nov" */
export const whenText = (ms: number, now: number) => (ymd(ms) === ymd(now) ? fmtTime(ms) : `${fmtTime(ms)} on ${fmtDate(ms)}`);
/** "3 h 52 min" / "12 min"; null once passed */
export function leftText(until: number, now: number): string | null {
  const m = Math.ceil((until - now) / 60000);
  if (m <= 0) return null;
  const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${m} min`;
}
