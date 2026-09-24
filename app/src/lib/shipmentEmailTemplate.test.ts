import { describe, it, expect } from 'vitest';
// ?raw so this reads the committed migration itself, not a copy of it — the
// same trick tokens.test.ts uses, and it keeps @types/node out of the build.
import migrationSql from '../../../supabase/migrations/20260923120000_shipment_confirmation_editable.sql?raw';
import {
  SHIPMENT_EMAIL_DEFAULT,
  SHIPMENT_EMAIL_VARIABLES,
  unsupportedVariables,
} from './shipmentEmailTemplate';

describe('SHIPMENT_EMAIL_DEFAULT', () => {
  it('carries both onboarding booking links', () => {
    expect(SHIPMENT_EMAIL_DEFAULT.body).toContain('https://calendly.com/lila-ed/intro-call');
    expect(SHIPMENT_EMAIL_DEFAULT.body)
      .toContain('https://calendly.com/lila-ed/lila-onboarding-with-danica-patrik');
  });

  it('no longer uses the bare Calendly profile URL', () => {
    // https://calendly.com/lila-ed was a profile page, not a bookable event.
    expect(SHIPMENT_EMAIL_DEFAULT.body).not.toMatch(/calendly\.com\/lila-ed[.\s]/);
  });

  it('only uses placeholders the renderer can fill', () => {
    expect(unsupportedVariables(SHIPMENT_EMAIL_DEFAULT)).toEqual([]);
  });
});

describe('unsupportedVariables', () => {
  it('flags the {{calendly_url}} row that shipped to production in May', () => {
    expect(unsupportedVariables({
      subject: 'Shipped ({{order_ref}})',
      body: 'Book a session here: {{calendly_url}}.',
    })).toEqual(['calendly_url']);
  });

  it('accepts every declared variable', () => {
    const body = SHIPMENT_EMAIL_VARIABLES.map(v => `{{${v}}}`).join('\n');
    expect(unsupportedVariables({ subject: '', body })).toEqual([]);
  });

  it('reports each unknown name once, from subject and body alike', () => {
    expect(unsupportedVariables({
      subject: '{{nope}}',
      body: '{{nope}} {{nope}} {{also_nope}}',
    }).sort()).toEqual(['also_nope', 'nope']);
  });
});

describe('migration 20260923120000', () => {
  // The migration is gated behind a manual workflow, so it may run long after
  // the code ships. If it ever does run it must produce exactly the wording
  // the app already uses, or the stored row would silently change the email.
  const sql = migrationSql;
  const update = sql.slice(sql.indexOf('update public.email_templates'), sql.indexOf('where key = '));
  const unquote = (s: string) => s.replace(/''/g, "'");

  it('seeds the same body the app defaults to', () => {
    const body = unquote(/\n {2}body =\s*\n?'([\s\S]*?)',\n {2}variables/.exec(update)![1]);
    expect(body).toBe(SHIPMENT_EMAIL_DEFAULT.body);
  });

  it('seeds the same subject', () => {
    const subject = unquote(/\n {2}subject = '(.*?)',\n/.exec(update)![1]);
    expect(subject).toBe(SHIPMENT_EMAIL_DEFAULT.subject);
  });
});
