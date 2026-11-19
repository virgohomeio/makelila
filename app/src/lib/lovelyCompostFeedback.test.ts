import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabaseTelemetry', () => ({ supabaseTelemetry: null, isTelemetryConfigured: false }));

import { averageReadings, toFeedback, ratingLabel } from './lovelyCompostFeedback';

describe('averageReadings', () => {
  it('averages humidity and temperature, ignoring nulls', () => {
    expect(averageReadings([
      { humidity: 44, temperature: 45 },
      { humidity: 47, temperature: null },
    ])).toEqual({ humidity: 45.5, temperature: 45, samples: 2 });
  });

  it('returns nulls for an empty or missing chamber', () => {
    expect(averageReadings([])).toEqual({ humidity: null, temperature: null, samples: 0 });
    expect(averageReadings(undefined)).toEqual({ humidity: null, temperature: null, samples: 0 });
  });
});

describe('toFeedback', () => {
  it('drops the raw snapshot and keeps per-chamber averages', () => {
    const f = toFeedback({
      id: '1', user_id: 'u', user_name: 'raquel', serial_number: 'LL01-00000000265',
      rating: 'too_wet', note: null, created_at: null,
      readings_snapshot: { left: [{ humidity: 80, temperature: 30 }], right: [] },
    });
    expect(f).not.toHaveProperty('readings_snapshot');
    expect(f.left.humidity).toBe(80);
    expect(f.right.humidity).toBeNull();
  });

  it('tolerates a null snapshot', () => {
    const f = toFeedback({
      id: '1', user_id: null, user_name: null, serial_number: null,
      rating: 'healthy', note: null, created_at: null, readings_snapshot: null,
    });
    expect(f.left.samples).toBe(0);
  });
});

describe('ratingLabel', () => {
  it('maps known codes and passes unknown ones through', () => {
    expect(ratingLabel('not_breaking_down')).toBe('Not breaking down');
    expect(ratingLabel('weird')).toBe('weird');
  });
});
