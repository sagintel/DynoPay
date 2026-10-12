import { badRequest } from './errors.js';

/**
 * All amounts are stored and computed as integer minor units (cents).
 * Conversion to/from major units happens only at the edges (API, agent, PayPal).
 */
export function toMinor(major: number | string): number {
  const n = typeof major === 'string' ? Number(major.replace(/[, ]/g, '')) : major;
  if (!Number.isFinite(n)) throw badRequest('Amount must be a number');
  const minor = Math.round(n * 100);
  if (Math.abs(n * 100 - minor) > 1e-6) throw badRequest('Amount can have at most 2 decimals');
  return minor;
}

export function toMajor(minor: number): number {
  return Math.round(minor) / 100;
}

/** PayPal expects "12.50" strings. */
export function toPayPalValue(minor: number): string {
  return (minor / 100).toFixed(2);
}

export function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

export function assertPositiveMinor(minor: number): void {
  if (!Number.isInteger(minor) || minor <= 0) throw badRequest('Amount must be greater than zero');
}
