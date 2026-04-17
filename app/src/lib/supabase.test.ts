import { describe, it, expect } from 'vitest';
import { supabase } from './supabase';

describe('supabase client', () => {
  it('exposes an auth namespace', () => {
    expect(supabase.auth).toBeDefined();
    expect(typeof supabase.auth.getSession).toBe('function');
  });

  it('exposes a from() builder', () => {
    expect(typeof supabase.from).toBe('function');
  });
});
