import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useKmsPages } from './kms';

const { mockResolve } = vi.hoisted(() => ({ mockResolve: vi.fn() }));

vi.mock('./supabase', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {};
  builder.select = () => builder;
  builder.order = () => builder;
  builder.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    mockResolve().then(onFulfilled, onRejected);
  return { supabase: { from: () => builder } };
});

describe('useKmsPages', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns pages on success', async () => {
    const fakePages = [
      {
        id: 'uuid-1',
        notion_page_id: 'abc123',
        section: 'Engineering',
        label: 'LILA Pro PRD',
        notion_url: 'https://notion.so/abc',
        title: 'LILA Pro + Lovely PRD',
        last_edited_by_name: 'Huayi Gao',
        last_edited_time: '2026-07-01T00:00:00.000Z',
        synced_at: '2026-07-10T06:00:00.000Z',
      },
    ];
    mockResolve.mockResolvedValueOnce({ data: fakePages, error: null });

    const { result } = renderHook(() => useKmsPages());
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pages).toEqual(fakePages);
    expect(result.current.error).toBeNull();
  });

  it('returns error on Supabase failure', async () => {
    mockResolve.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } });

    const { result } = renderHook(() => useKmsPages());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('DB error');
    expect(result.current.pages).toEqual([]);
  });

  it('starts with loading=true and empty pages', () => {
    mockResolve.mockImplementation(() => new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useKmsPages());
    expect(result.current.loading).toBe(true);
    expect(result.current.pages).toEqual([]);
  });
});
