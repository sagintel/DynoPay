let uiLocale = 'en-US';
/** Dates follow the UI language (falls back to English when the device lacks that locale). */
export function setUiLocale(lang: string) {
  uiLocale = !lang || lang === 'en' ? 'en-US' : lang;
}
export function localDate(d: Date, opts: Intl.DateTimeFormatOptions): string {
  try {
    return d.toLocaleDateString(uiLocale, opts);
  } catch {
    return d.toLocaleDateString('en-US', opts);
  }
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', AED: 'Đ', JPY: '¥', CAD: '$', AUD: '$', XAF: 'FCFA ', NGN: '₦', INR: '₹' };

export const currencySymbol = (currency = 'USD') => SYMBOLS[currency] ?? `${currency} `;

/** "12480.5" → { symbol: "$", whole: "12,480", cents: ".50" } — the big balance renders cents smaller. */
export function splitMoney(amount: number, currency = 'USD') {
  const abs = Math.abs(amount);
  const whole = Math.floor(abs + 1e-9);
  const cents = Math.round((abs - whole) * 100);
  return {
    sign: amount < 0 ? '−' : '',
    symbol: currencySymbol(currency),
    whole: whole.toLocaleString('en-US'),
    cents: `.${String(cents).padStart(2, '0')}`,
  };
}

export function money(amount: number, currency = 'USD', opts: { signed?: boolean } = {}) {
  const { symbol, whole, cents } = splitMoney(amount, currency);
  const sign = opts.signed ? (amount < 0 ? '– ' : '+ ') : amount < 0 ? '–' : '';
  return `${sign}${symbol}${whole}${cents}`;
}

export function dayLabel(iso: string, now = new Date()) {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return localDate(d, { weekday: 'long' });
  return localDate(d, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export const timeLabel = (iso: string) => {
  try {
    return new Date(iso).toLocaleTimeString(uiLocale, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
};

export const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

export function txSubtitle(t: { category: string; note: string | null; kind: string; status: string }) {
  const parts = [t.note ?? titleCase(t.kind === 'card_spend' ? t.category : t.kind === 'topup' ? 'Top up' : t.category)];
  if (t.status === 'pending') parts.push('Pending');
  if (t.status === 'failed') parts.push('Failed');
  return parts.join(' · ');
}
