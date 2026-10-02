import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
vi.mock('./supabaseTelemetry', () => ({
  supabaseTelemetry: null,
  isTelemetryConfigured: false,
  TELEMETRY_URL: undefined,
  TELEMETRY_ANON_KEY: undefined,
}));

import { attachPhotos } from './lovelyTickets';

const report = (id: string) => ({
  id, user_id: 'u1', serial_number: 'LL01-00000000372', notes: 'n',
  created_at: '2026-09-30T00:00:00Z', updated_at: null,
});

describe('attachPhotos', () => {
  it('groups photo paths under their report in upload order', () => {
    const out = attachPhotos(
      [report('a'), report('b')],
      [
        { damage_report_id: 'a', raw_object_path: 'u1/2.jpg', created_at: '2026-09-30T00:00:02Z' },
        { damage_report_id: 'a', raw_object_path: 'u1/1.jpg', created_at: '2026-09-30T00:00:01Z' },
      ],
    );
    expect(out[0].photoPaths).toEqual(['u1/1.jpg', 'u1/2.jpg']);
    expect(out[1].photoPaths).toEqual([]);
  });

  it('skips images without an object path', () => {
    const out = attachPhotos(
      [report('a')],
      [{ damage_report_id: 'a', raw_object_path: null, created_at: null }],
    );
    expect(out[0].photoPaths).toEqual([]);
  });
});
