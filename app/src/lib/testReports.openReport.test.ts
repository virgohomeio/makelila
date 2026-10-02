// The QC modal's "Report:" link did nothing when clicked. Two causes, both
// confirmed against the live bucket for unit LL01-00000000351:
//
//   1. The tab was opened *after* awaiting the signed URL, so it landed outside
//      the click's user-gesture window and browsers blocked it silently. It was
//      also opened with 'noopener', which makes window.open return null by spec,
//      so a blocked tab was indistinguishable from a good one and went unnoticed.
//   2. Every stored report is served as `application/octet-stream` (the bulk
//      importer's contentType never stuck), which browsers download rather than
//      render — so even an unblocked tab came up blank.
//
// openTestReport fixes both: claim the tab synchronously, then point it at a
// blob of the file re-typed as text so the report is actually readable.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createSignedUrlMock } = vi.hoisted(() => ({
  createSignedUrlMock: vi.fn(),
}));

vi.mock('./supabase', () => ({
  supabase: { storage: { from: () => ({ createSignedUrl: createSignedUrlMock }) } },
}));

import { openTestReport } from './testReports';

const fakeTab = () => ({
  closed: false,
  opener: {} as unknown,
  location: { replace: vi.fn(), assign: vi.fn() },
  document: { write: vi.fn() },
  close: vi.fn(),
});

const PATH = 'LL01-00000000351/1784233188583-LL01-00000000351.md';

describe('openTestReport', () => {
  const realOpen = window.open;
  const realLocation = window.location;
  const realFetch = globalThis.fetch;
  const realCreateObjectURL = URL.createObjectURL;

  beforeEach(() => {
    createSignedUrlMock.mockReset();
    URL.createObjectURL = vi.fn(() => 'blob:fake-url') as any;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      // What storage actually returns today: the report bytes typed as a download.
      blob: async () => new Blob(['# VCycene LILA Test Report'], { type: 'application/octet-stream' }),
    })) as any;
  });

  afterEach(() => {
    window.open = realOpen;
    globalThis.fetch = realFetch;
    URL.createObjectURL = realCreateObjectURL;
    Object.defineProperty(window, 'location', { value: realLocation, configurable: true, writable: true });
  });

  it('opens the tab before the signed URL is awaited', async () => {
    const tab = fakeTab();
    const openSpy = vi.fn(() => tab);
    window.open = openSpy as any;

    let resolveSign: (v: any) => void = () => {};
    createSignedUrlMock.mockReturnValue(new Promise(res => { resolveSign = res; }));

    const pending = openTestReport(PATH);
    expect(openSpy).toHaveBeenCalledTimes(1); // ← synchronous, inside the gesture
    expect(tab.location.replace).not.toHaveBeenCalled();

    resolveSign({ data: { signedUrl: 'https://signed.example/report.md' }, error: null });
    await pending;
    expect(tab.location.replace).toHaveBeenCalledWith('blob:fake-url');
    expect(tab.opener).toBeNull(); // reverse-tabnabbing guard; we can't pass noopener
  });

  it('re-types the octet-stream body as text so the browser renders it', async () => {
    window.open = vi.fn(() => fakeTab()) as any;
    createSignedUrlMock.mockResolvedValue({ data: { signedUrl: 'https://signed.example/report.md' }, error: null });

    await openTestReport(PATH);

    const blob = (URL.createObjectURL as any).mock.calls[0][0] as Blob;
    expect(blob.type).toBe('text/plain;charset=utf-8');
    expect(await blob.text()).toBe('# VCycene LILA Test Report');
  });

  it('falls back to the current tab when the browser blocked the open', async () => {
    window.open = vi.fn(() => null) as any;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign }, configurable: true, writable: true });
    createSignedUrlMock.mockResolvedValue({ data: { signedUrl: 'https://signed.example/report.md' }, error: null });

    await openTestReport(PATH);
    expect(assign).toHaveBeenCalledWith('blob:fake-url');
  });

  it('closes the placeholder tab and rethrows when signing fails', async () => {
    const tab = fakeTab();
    window.open = vi.fn(() => tab) as any;
    createSignedUrlMock.mockResolvedValue({ data: null, error: { message: 'Object not found' } });

    await expect(openTestReport(PATH)).rejects.toThrow('Object not found');
    expect(tab.close).toHaveBeenCalled();
  });

  it('closes the placeholder tab and rethrows when the download fails', async () => {
    const tab = fakeTab();
    window.open = vi.fn(() => tab) as any;
    createSignedUrlMock.mockResolvedValue({ data: { signedUrl: 'https://signed.example/report.md' }, error: null });
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob([]) })) as any;

    await expect(openTestReport(PATH)).rejects.toThrow('404');
    expect(tab.close).toHaveBeenCalled();
  });
});
