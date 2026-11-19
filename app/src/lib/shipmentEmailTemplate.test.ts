import { describe, it, expect } from 'vitest';
import { textToEmailHtml } from '../../../supabase/functions/_shared/emailHtml.ts';
import {
  ONBOARDING_EMAIL_DEFAULT,
  ONBOARDING_SMS_DEFAULT,
  renderPlaceholders,
  unfilledPlaceholders,
} from '../../../supabase/functions/_shared/onboardingEmail.ts';
import {
  LOVELY_INSTALL_GUIDE_URL,
  SHIPMENT_EMAIL_DEFAULT,
  SHIPMENT_EMAIL_TEMPLATE_KEY,
  SHIPMENT_EMAIL_VARIABLES,
  SHIPMENT_SMS_DEFAULT,
  unsupportedVariables,
} from './shipmentEmailTemplate';

describe('SHIPMENT_EMAIL_DEFAULT', () => {
  it('has the shipping-information subject', () => {
    expect(SHIPMENT_EMAIL_DEFAULT.subject).toBe('Important Information For Your LILA Shipment');
  });

  it('carries the shipping details and tracking', () => {
    const body = SHIPMENT_EMAIL_DEFAULT.body;
    expect(body).toContain('{{carrier}}');
    expect(body).toContain('{{tracking_num}}');
    expect(body).toContain('{{tracking_url}}');
    expect(body).toContain('{{starter_block}}');
  });

  it('tells the customer a signature is required', () => {
    expect(SHIPMENT_EMAIL_DEFAULT.body).toMatch(/signature is required/i);
  });

  it('leaves the Lovely App and onboarding-call instructions to the next-day email', () => {
    const body = SHIPMENT_EMAIL_DEFAULT.body;
    expect(body).not.toContain('calendly.com');
    expect(body).not.toContain('lilalovely.io');
    expect(body).not.toContain(LOVELY_INSTALL_GUIDE_URL);
  });

  it('only uses placeholders the renderer can fill', () => {
    expect(unsupportedVariables(SHIPMENT_EMAIL_DEFAULT)).toEqual([]);
  });

  it('reads its override from a new key, not the old combined template', () => {
    expect(SHIPMENT_EMAIL_TEMPLATE_KEY).not.toBe('shipment_confirmation');
  });
});

describe('SHIPMENT_SMS_DEFAULT', () => {
  it('condenses the same tracking and signature information', () => {
    expect(SHIPMENT_SMS_DEFAULT).toContain('{{tracking_num}}');
    expect(SHIPMENT_SMS_DEFAULT).toContain('{{tracking_url}}');
    expect(SHIPMENT_SMS_DEFAULT).toMatch(/signature is required/i);
    expect(unsupportedVariables({ subject: '', body: SHIPMENT_SMS_DEFAULT })).toEqual([]);
  });
});

describe('ONBOARDING_EMAIL_DEFAULT (next-day email)', () => {
  it('has the ACTION NEEDED subject', () => {
    expect(ONBOARDING_EMAIL_DEFAULT.subject).toBe('ACTION NEEDED: Onboarding Instructions for your LILA');
  });

  it('carries the Lovely App sign-in and both onboarding booking links', () => {
    const body = ONBOARDING_EMAIL_DEFAULT.body;
    expect(body).toContain('lilalovely.io');
    expect(body).toMatch(/iPhone[\s\S]*Safari/);
    expect(body).toMatch(/Android[\s\S]*Chrome/);
    expect(body).toContain('https://calendly.com/lila-ed/intro-call');
    expect(body).toContain('https://calendly.com/lila-ed/lila-onboarding-with-danica-patrik');
    expect(body.indexOf('Lovely App')).toBeLessThan(body.indexOf('onboarding call'));
  });

  it('puts the install guide on a line of its own so it sends as a picture', () => {
    expect(ONBOARDING_EMAIL_DEFAULT.body.split('\n')).toContain(LOVELY_INSTALL_GUIDE_URL);
    expect(textToEmailHtml(ONBOARDING_EMAIL_DEFAULT.body))
      .toContain(`<img src="${LOVELY_INSTALL_GUIDE_URL}"`);
  });

  it('fills every placeholder in the email and the text', () => {
    const vars = { customer_first_name: 'Ada', order_ref: '#1300' };
    for (const t of [ONBOARDING_EMAIL_DEFAULT.subject, ONBOARDING_EMAIL_DEFAULT.body, ONBOARDING_SMS_DEFAULT]) {
      expect(unfilledPlaceholders(renderPlaceholders(t, vars))).toEqual([]);
    }
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
