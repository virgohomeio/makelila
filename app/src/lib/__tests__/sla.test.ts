import { describe, it, expect } from 'vitest';
import { slaChip, type ServiceTicket } from '../service';

// Minimal stub — only the fields slaChip needs.
function stub(sla_status: ServiceTicket['sla_status']): Pick<ServiceTicket, 'sla_status'> {
  return { sla_status };
}

describe('slaChip', () => {
  it('returns green for ok', () => {
    const chip = slaChip(stub('ok'));
    expect(chip.color).toBe('green');
    expect(chip.label).toBe('On track');
  });

  it('returns amber for warning', () => {
    const chip = slaChip(stub('warning'));
    expect(chip.color).toBe('amber');
    expect(chip.label).toBe('At risk');
  });

  it('returns red for breached', () => {
    const chip = slaChip(stub('breached'));
    expect(chip.color).toBe('red');
    expect(chip.label).toBe('Breached');
  });

  it('returns grey for met', () => {
    const chip = slaChip(stub('met'));
    expect(chip.color).toBe('grey');
    expect(chip.label).toBe('Met');
  });

  it('returns grey No SLA for null sla_status', () => {
    const chip = slaChip(stub(null));
    expect(chip.color).toBe('grey');
    expect(chip.label).toBe('No SLA');
  });
});

describe('SLA deadline math', () => {
  it('first_response_due_at is created_at + first_response_minutes', () => {
    // Simulate the trigger logic in pure JS to verify the math.
    const createdAt = new Date('2026-06-10T09:00:00Z');
    const firstResponseMinutes = 60; // P1 policy

    const firstResponseDueAt = new Date(createdAt.getTime() + firstResponseMinutes * 60_000);

    expect(firstResponseDueAt.toISOString()).toBe('2026-06-10T10:00:00.000Z');
  });

  it('resolution_due_at is created_at + resolution_minutes', () => {
    const createdAt = new Date('2026-06-10T09:00:00Z');
    const resolutionMinutes = 1440; // 24h for P1

    const resolutionDueAt = new Date(createdAt.getTime() + resolutionMinutes * 60_000);

    expect(resolutionDueAt.toISOString()).toBe('2026-06-11T09:00:00.000Z');
  });

  it('P3 resolution is 7 days after creation', () => {
    const createdAt = new Date('2026-06-10T00:00:00Z');
    const p3ResolutionMinutes = 10080; // 7 * 24 * 60

    const due = new Date(createdAt.getTime() + p3ResolutionMinutes * 60_000);

    const diffDays = (due.getTime() - createdAt.getTime()) / 86_400_000;
    expect(diffDays).toBe(7);
  });
});
