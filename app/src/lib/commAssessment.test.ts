import { describe, it, expect } from 'vitest';
import {
  phoneKey,
  emailKey,
  selectMessages,
  fingerprintSource,
  parseAssessment,
  commTone,
  channelFootnote,
  noContactAssessment,
  buildTranscript,
  commDetail,
  VERDICT_LABEL,
  CONCERN_LABELS,
  type CommMessage,
  type ChannelsScanned,
} from './commAssessment';

const msg = (over: Partial<CommMessage> = {}): CommMessage => ({
  id: 'm1',
  ticket_id: 't1',
  channel: 'quo',
  direction: 'inbound',
  sent_at: '2026-09-01T12:00:00Z',
  text: 'hello',
  ...over,
});

describe('phoneKey', () => {
  it('reduces any format to the last ten digits', () => {
    expect(phoneKey('+1 (416) 555-0134')).toBe('4165550134');
    expect(phoneKey('416-555-0134')).toBe('4165550134');
    expect(phoneKey('14165550134')).toBe('4165550134');
  });

  it('rejects anything too short to identify a person', () => {
    expect(phoneKey('555-0134')).toBeNull();
    expect(phoneKey('')).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });
});

describe('emailKey', () => {
  it('lower-cases and trims', () => {
    expect(emailKey('  Jane@Example.COM ')).toBe('jane@example.com');
  });
  it('rejects a value with no @', () => {
    expect(emailKey('not-an-email')).toBeNull();
    expect(emailKey(null)).toBeNull();
  });
});

describe('selectMessages', () => {
  const now = new Date('2026-09-10T00:00:00Z');

  it('drops anything older than the window', () => {
    const kept = selectMessages(
      [msg({ id: 'old', sent_at: '2026-01-01T00:00:00Z' }), msg({ id: 'new' })],
      { now, windowDays: 120, max: 60 },
    );
    expect(kept.map(m => m.id)).toEqual(['new']);
  });

  it('keeps the newest N and returns them oldest-first for the model', () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      msg({ id: `m${i}`, sent_at: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z` }));
    const kept = selectMessages(many, { now, windowDays: 120, max: 10 });
    expect(kept).toHaveLength(10);
    // oldest-first: a transcript reads forwards, the way the conversation happened
    const times = kept.map(m => m.sent_at);
    expect([...times].sort()).toEqual(times);
  });

  it('drops messages with no usable text', () => {
    const kept = selectMessages([msg({ id: 'blank', text: '   ' }), msg({ id: 'real' })], { now, windowDays: 120, max: 60 });
    expect(kept.map(m => m.id)).toEqual(['real']);
  });
});

describe('fingerprintSource', () => {
  it('is stable under reordering — the same messages are the same input', () => {
    const a = fingerprintSource([msg({ id: 'a' }), msg({ id: 'b' })], 'pending');
    const b = fingerprintSource([msg({ id: 'b' }), msg({ id: 'a' })], 'pending');
    expect(a).toBe(b);
  });

  it('changes when a new message arrives', () => {
    const before = fingerprintSource([msg({ id: 'a' })], 'pending');
    const after  = fingerprintSource([msg({ id: 'a' }), msg({ id: 'b' })], 'pending');
    expect(after).not.toBe(before);
  });

  it('changes when the order status changes, so a re-opened order is re-read', () => {
    expect(fingerprintSource([msg()], 'pending')).not.toBe(fingerprintSource([msg()], 'approved'));
  });
});

describe('parseAssessment', () => {
  it('accepts a well-formed model reply', () => {
    const out = parseAssessment({
      verdict: 'unclear',
      headline: 'Customer asked to cancel on Sep 3',
      concerns: ['cancel_intent'],
      evidence: [{ channel: 'quo', direction: 'inbound', sent_at: '2026-09-03T01:00:00Z', excerpt: 'put it in the trash pile' }],
    });
    expect(out.verdict).toBe('unclear');
    expect(out.concerns).toEqual(['cancel_intent']);
    expect(out.evidence[0].excerpt).toBe('put it in the trash pile');
  });

  it('drops concerns outside the fixed vocabulary rather than trusting the model', () => {
    const out = parseAssessment({ verdict: 'unclear', headline: 'x', concerns: ['cancel_intent', 'aliens'] });
    expect(out.concerns).toEqual(['cancel_intent']);
  });

  it('falls back to unclear on an unrecognised verdict — an unreadable answer is not a clearance', () => {
    const out = parseAssessment({ verdict: 'probably fine', headline: 'x' });
    expect(out.verdict).toBe('unclear');
  });

  it('caps evidence at three items and clamps excerpt length', () => {
    const out = parseAssessment({
      verdict: 'unclear',
      headline: 'x',
      evidence: Array.from({ length: 6 }, () => ({ channel: 'quo', excerpt: 'y'.repeat(400) })),
    });
    expect(out.evidence).toHaveLength(3);
    expect(out.evidence[0].excerpt.length).toBeLessThanOrEqual(240);
  });

  it('supplies a headline when the model omits one', () => {
    const out = parseAssessment({ verdict: 'clear' });
    expect(out.headline.length).toBeGreaterThan(0);
  });
});

describe('commTone', () => {
  it('maps both safe verdicts to good and unclear to warn', () => {
    expect(commTone('clear')).toBe('good');
    expect(commTone('no_contact')).toBe('good');
    expect(commTone('unclear')).toBe('warn');
  });
});

describe('channelFootnote', () => {
  const scanned = (over: Partial<ChannelsScanned> = {}): ChannelsScanned => ({
    quo:   { connected: true,  last_synced_at: '2026-09-09T00:00:00Z', message_count: 12 },
    email: { connected: false, last_synced_at: null, message_count: 0 },
    ...over,
  });

  it('names a disconnected channel outright, so a clearance is never read as complete', () => {
    expect(channelFootnote(scanned())).toContain('Support email not connected');
  });

  it('dates a connected channel', () => {
    const text = channelFootnote(scanned());
    expect(text).toMatch(/Quo/);
    expect(text).toMatch(/Sep 9/);
  });

  it('reports both connected when they are', () => {
    const text = channelFootnote(scanned({
      email: { connected: true, last_synced_at: '2026-09-10T00:00:00Z', message_count: 3 },
    }));
    expect(text).not.toContain('not connected');
    expect(text).toContain('Support email');
  });
});

describe('noContactAssessment', () => {
  it('is a clearance that says no one has been in touch', () => {
    const a = noContactAssessment();
    expect(a.verdict).toBe('no_contact');
    expect(a.headline).toMatch(/no support contact/i);
    expect(a.concerns).toEqual([]);
  });
});

describe('buildTranscript', () => {
  it('labels direction and channel per line so the model knows who spoke', () => {
    const text = buildTranscript([
      msg({ id: 'a', direction: 'inbound',  text: 'I want to cancel' }),
      msg({ id: 'b', direction: 'outbound', text: 'Sorry to hear that' }),
    ]);
    expect(text).toContain('CUSTOMER');
    expect(text).toContain('SUPPORT');
    expect(text).toContain('I want to cancel');
  });
});

describe('CONCERN_LABELS', () => {
  it('gives every concern in the vocabulary a human label', () => {
    for (const [key, label] of Object.entries(CONCERN_LABELS)) {
      expect(label, key).toBeTruthy();
      expect(label).not.toBe(key);
    }
  });
});

describe('VERDICT_LABEL + commDetail', () => {
  it('leads both safe verdicts with the same words, so a queue scans', () => {
    expect(VERDICT_LABEL.clear).toBe('Clear to ship');
    expect(VERDICT_LABEL.no_contact).toBe('Clear to ship');
  });

  it('asks for confirmation on the unclear verdict', () => {
    expect(VERDICT_LABEL.unclear).toMatch(/confirm the desire to ship/i);
  });

  it("keeps the model's specific sentence as the detail line", () => {
    expect(commDetail('unclear', 'Customer asked to cancel on Sep 3'))
      .toBe('Customer asked to cancel on Sep 3');
    expect(commDetail('clear', 'No shipping obstacles identified; timeline acknowledged.'))
      .toBe('No shipping obstacles identified; timeline acknowledged.');
  });

  it('does not restate the label when the stored headline is the generated default', () => {
    expect(commDetail('no_contact', 'Clear to ship — no support contact on file'))
      .toBe('No support contact on file');
    expect(commDetail('clear', 'Clear to ship — nothing in recent contact affects this shipment'))
      .toBe('Nothing in recent contact affects this shipment');
  });

  it('strips a duplicated lead when the model opens with the label itself', () => {
    expect(commDetail('clear', 'Clear to ship - customer confirmed the address'))
      .toBe('customer confirmed the address');
  });

  it('has no detail to show before anything has been assessed', () => {
    expect(commDetail(null, null)).toBeNull();
  });
});
