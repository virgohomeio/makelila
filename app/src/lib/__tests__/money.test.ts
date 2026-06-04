import { describe, it, expect } from 'vitest';
import { formatMoney } from '../money';

describe('formatMoney', () => {
  it('appends the currency code', () => {
    expect(formatMoney(200, 'USD')).toBe('$200.00 USD');
    expect(formatMoney(200, 'CAD')).toBe('$200.00 CAD');
  });

  it('renders an em dash for null/undefined', () => {
    expect(formatMoney(null, 'USD')).toBe('—');
    expect(formatMoney(undefined, 'CAD')).toBe('—');
  });

  it('falls back to USD when currency is missing', () => {
    expect(formatMoney(200, undefined)).toBe('$200.00 USD');
    expect(formatMoney(200, null)).toBe('$200.00 USD');
    expect(formatMoney(200, '')).toBe('$200.00 USD');
  });
});
