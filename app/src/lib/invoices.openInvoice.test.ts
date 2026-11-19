// "View" on an invoice used to sign the URL first and open the tab second, so
// the window.open landed outside the click's user-gesture window and browsers
// blocked it with no error — the button simply did nothing (reported against
// a refund card whose invoice and storage object were both fine). The tab must
// therefore be claimed synchronously, before any await.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createSignedUrlMock } = vi.hoisted(() => ({
  createSignedUrlMock: vi.fn(),
}));

vi.mock('./supabase', () => ({
  supabase: { storage: { from: () => ({ createSignedUrl: createSignedUrlMock }) } },
}));

import { openInvoiceInNewTab } from './invoices';

const fakeTab = () => ({
  closed: false,
  opener: {} as unknown,
  location: { replace: vi.fn(), assign: vi.fn() },
  document: { write: vi.fn() },
  close: vi.fn(),
});

describe('openInvoiceInNewTab', () => {
  const realOpen = window.open;
  const realLocation = window.location;

  beforeEach(() => { createSignedUrlMock.mockReset(); });
  afterEach(() => {
    window.open = realOpen;
    // jsdom's location.assign is not redefinable, so the fallback test swaps
    // the whole location object out and puts it back here.
    Object.defineProperty(window, 'location', { value: realLocation, configurable: true, writable: true });
  });

  it('opens the tab before the signed URL is awaited', async () => {
    const tab = fakeTab();
    const openSpy = vi.fn(() => tab);
    window.open = openSpy as any;

    // Hold the signing call open so we can inspect the world mid-await.
    let resolveSign: (v: any) => void = () => {};
    createSignedUrlMock.mockReturnValue(new Promise(res => { resolveSign = res; }));

    const pending = openInvoiceInNewTab('inbound/inv.pdf');
    expect(openSpy).toHaveBeenCalledTimes(1); // ← the whole point: synchronous
    expect(tab.location.replace).not.toHaveBeenCalled();

    resolveSign({ data: { signedUrl: 'https://signed.example/inv.pdf' }, error: null });
    await pending;
    expect(tab.location.replace).toHaveBeenCalledWith('https://signed.example/inv.pdf');
    expect(tab.opener).toBeNull(); // reverse-tabnabbing guard, since we can't pass noopener
  });

  it('falls back to the current tab when the browser blocked the open', async () => {
    window.open = vi.fn(() => null) as any;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign }, configurable: true, writable: true });
    createSignedUrlMock.mockResolvedValue({ data: { signedUrl: 'https://signed.example/x.pdf' }, error: null });

    await openInvoiceInNewTab('inbound/x.pdf');
    expect(assign).toHaveBeenCalledWith('https://signed.example/x.pdf');
  });

  it('closes the placeholder tab and rethrows when signing fails', async () => {
    const tab = fakeTab();
    window.open = vi.fn(() => tab) as any;
    createSignedUrlMock.mockResolvedValue({ data: null, error: { message: 'Object not found' } });

    await expect(openInvoiceInNewTab('inbound/gone.pdf')).rejects.toThrow('Object not found');
    expect(tab.close).toHaveBeenCalled();
  });
});
