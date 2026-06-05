import { describe, it, expect } from 'vitest';
import { classify, CATEGORY_LABEL, type ThreadInput } from '../classifier';

// Reference "now" for deterministic time-based rules. Fixtures are dated
// from the brief (2026-05-13..05-19); we pin `now` to 2026-05-19T12:00:00Z.
const NOW = Date.parse('2026-05-19T12:00:00Z');

function thread(
  messages: ThreadInput['messages'],
  opts: Partial<Omit<ThreadInput, 'messages' | 'now'>> = {},
): ThreadInput {
  return {
    subject: opts.subject ?? 'Customer thread',
    customer_name: opts.customer_name ?? 'Test Customer',
    messages,
    now: NOW,
  };
}

function msg(
  direction: 'inbound' | 'outbound',
  body: string,
  dayISO: string,
): ThreadInput['messages'][number] {
  return { direction, body_text: body, sent_at: `${dayISO}T10:00:00Z` };
}

describe('classifier — fixtures from the brief', () => {
  it('escalating-return → urgent + return_hardware_defect', () => {
    const t = thread([
      msg('inbound', 'My wife has been saying the whole house is smelling from the composter.', '2026-05-15'),
      msg('inbound', 'Part 3 is not connecting',                                                  '2026-05-15'),
      msg('inbound', 'Sorry that my unit is having a lot of issues. Please keep me updated.',     '2026-05-15'),
      msg('inbound', 'Form filled out.',                                                          '2026-05-16'),
      msg('inbound', 'Sorry I am confused on why this is taking so long? I was on the video call with him first hand and he saw my unit.', '2026-05-19'),
    ]);
    const r = classify(t);
    expect(r.priority).toBe('urgent');
    expect(r.category).toBe('return_hardware_defect');
    expect(r.method).toBe('rules');
    expect(r.ruleId).toBe('return-hardware-multi-issue');
  });

  it('refund-overdue → high + refund', () => {
    const t = thread([
      msg('inbound', 'Could you please check on the status of the refund? Its been 10 days since the item was picked up.', '2026-05-14'),
    ]);
    const r = classify(t);
    expect(r.priority).toBe('high');
    expect(r.category).toBe('refund');
  });

  it('cracked-bin → high + warranty_replacement', () => {
    const t = thread([
      msg('inbound', 'Hi can you help me with my composter. It has a large crack on one of the bins where I place the compost.', '2026-05-14'),
    ]);
    const r = classify(t);
    expect(r.priority).toBe('high');
    expect(r.category).toBe('warranty_replacement');
  });

  it('closed-thanks → low + closed_acknowledgment + resolved', () => {
    const t = thread([
      msg('inbound', 'Thanks 🙂', '2026-05-13'),
    ]);
    const r = classify(t);
    expect(r.priority).toBe('low');
    expect(r.category).toBe('closed_acknowledgment');
    expect(r.status).toBe('closed');
    expect(r.ruleId).toBe('closed-ack');
  });

  it('nightmare-no-context → high + complaint + "call" in next action', () => {
    // Dated today (relative to test NOW) so the escalation-no-reply rule
    // doesn't promote to urgent; complaint-emotional should fire on tone.
    const t = thread([
      msg('inbound', 'What a nightmare', '2026-05-19'),
    ]);
    const r = classify(t);
    expect(r.priority).toBe('high');
    expect(r.category).toBe('complaint');
    expect(r.suggested_next_action.toLowerCase()).toContain('call');
  });
});

describe('classifier — additional cases', () => {
  it('falls through to other when no rule fires', () => {
    const t = thread([
      msg('inbound', 'Quick question about delivery timing.', '2026-05-19'),
    ]);
    const r = classify(t);
    expect(r.category).toBe('other');
    expect(r.priority).toBe('medium');
    expect(r.method).toBe('rules');
    expect(r.ruleId).toBeUndefined();
  });

  it('missed-call subject → medium + callback', () => {
    const t = thread(
      [msg('inbound', 'Hi — missed your call, please call back.', '2026-05-19')],
      { subject: 'Missed call from RJ Down (813) 492-5113' },
    );
    const r = classify(t);
    expect(r.priority).toBe('medium');
    expect(r.category).toBe('callback');
    expect(r.ruleId).toBe('missed-call');
  });

  it('aged inbound with no outbound → urgent + complaint (escalation-no-reply)', () => {
    const t = thread([
      msg('inbound', 'Where is my replacement? Two weeks now.', '2026-05-15'),
    ]);
    const r = classify(t);
    expect(r.priority).toBe('urgent');
    expect(r.category).toBe('complaint');
    expect(r.ruleId).toBe('escalation-no-reply');
  });

  it('does not escalate when an outbound reply exists', () => {
    const t = thread([
      msg('inbound', 'Where is my replacement?', '2026-05-15'),
      msg('outbound', 'Replacement shipped today, here is the tracking number.', '2026-05-16'),
    ]);
    const r = classify(t);
    expect(r.priority).not.toBe('urgent');
  });

  it('firmware-disconnect catches Wi-Fi issues', () => {
    const t = thread([
      msg('inbound', "Unit won't connect to wifi after I moved it.", '2026-05-19'),
    ]);
    const r = classify(t);
    expect(r.category).toBe('software_firmware');
    expect(r.priority).toBe('high');
  });

  it('appointment-scheduled after outbound proposal', () => {
    const t = thread([
      msg('outbound', 'Can we do Thursday at 2pm Pacific for the call?', '2026-05-18'),
      msg('inbound', 'Sounds good — see you then', '2026-05-19'),
    ]);
    const r = classify(t);
    expect(r.category).toBe('appointment');
    expect(r.priority).toBe('low');
  });

  it('subject is generated as "${name} — ${category label}"', () => {
    const t = thread(
      [msg('inbound', 'Thanks 🙂', '2026-05-13')],
      { customer_name: 'RJ Down' },
    );
    const r = classify(t);
    expect(r.subject).toBe(`RJ Down — ${CATEGORY_LABEL.closed_acknowledgment}`);
  });

  it('summary truncates long inbound text', () => {
    const long = 'A'.repeat(250);
    const t = thread([msg('inbound', long, '2026-05-19')]);
    const r = classify(t);
    expect(r.summary.length).toBeLessThanOrEqual(180);
    expect(r.summary.endsWith('...')).toBe(true);
  });
});
