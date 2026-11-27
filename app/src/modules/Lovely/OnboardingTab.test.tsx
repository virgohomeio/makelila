import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { LovelyUser } from '../../lib/lovely';
import type { ActivityEntry } from '../../lib/lovelyActivity';

const { useLovelyUsersMock, useLovelyActivityMock } = vi.hoisted(() => ({
  useLovelyUsersMock: vi.fn(),
  useLovelyActivityMock: vi.fn(),
}));

vi.mock('../../lib/lovely', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/lovely')>()),
  useLovelyUsers: useLovelyUsersMock,
}));
vi.mock('../../lib/lovelyActivity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/lovelyActivity')>()),
  useLovelyActivity: useLovelyActivityMock,
}));

import { OnboardingTab } from './OnboardingTab';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const mk = (over: Partial<LovelyUser>): LovelyUser => ({
  id: 'x', email: 'x@x.com', first_name: null, last_name: null,
  serial_number: null, onboarding_step: 'pairing', is_verified: true, verified_at: null,
  mailing_list: null, last_login_at: null, login_count: null,
  created_at: daysAgo(20), updated_at: null, phone_number: null, onboarding_step_at: null,
  ...over,
});

const stuckOnWifi = mk({
  id: 'w', email: 'wifi@x.com', first_name: 'Wendy', onboarding_step: 'hardware_done',
  onboarding_step_at: daysAgo(5), phone_number: '+15550001111',
});
const neverOnline = mk({
  id: 'a', email: 'angela@x.com', first_name: 'Angela', onboarding_step: 'tour_done',
  serial_number: 'LL01-00000000363', onboarding_step_at: daysAgo(10),
});

const entry = (user: LovelyUser, machine: ActivityEntry['machine']): ActivityEntry => ({
  user, activity: null, lastSeenAt: null, last: { at: null, signal: null },
  app: 'active', machine, status: 'unit_down',
});

beforeEach(() => {
  vi.clearAllMocks();
  useLovelyUsersMock.mockReturnValue({
    users: [stuckOnWifi, neverOnline], loading: false, error: null, refetch: vi.fn(),
  });
  useLovelyActivityMock.mockReturnValue({
    entries: [entry(neverOnline, 'never')], nowMs: NOW, telemetryError: null,
  });
});

describe('OnboardingTab', () => {
  it('flags stuck customers on their funnel step', () => {
    render(<OnboardingTab onGoToVerification={vi.fn()} />);
    const row = screen.getByRole('button', { name: /Hardware walkthrough/ });
    expect(within(row).getByText('1 stuck 3+ days')).toBeInTheDocument();
  });

  it('opens a step to list who is on it, with contact details and wait time', () => {
    render(<OnboardingTab onGoToVerification={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Hardware walkthrough/ }));

    expect(screen.getByText(/now on: WiFi setup/)).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Wendy')).toBeInTheDocument();
    expect(within(table).getByText('wifi@x.com')).toHaveAttribute('href', 'mailto:wifi@x.com');
    expect(within(table).getByText('+15550001111')).toHaveAttribute('href', 'tel:+15550001111');
    expect(within(table).getByText('5 days')).toBeInTheDocument();
    expect(within(table).getByText('Stuck')).toBeInTheDocument();
    expect(within(table).queryByText('Angela')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Hardware walkthrough/ }));
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('calls out finished setups whose machine never came online and lists them', () => {
    render(<OnboardingTab onGoToVerification={vi.fn()} />);
    expect(screen.getByText(/1 customer finished setup 3\+ days/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'show' }));
    const table = screen.getByRole('table');
    expect(within(table).getByText('Angela')).toBeInTheDocument();
    expect(within(table).getByText('Never seen')).toBeInTheDocument();
    expect(within(table).queryByText('Wendy')).toBeNull();
  });

  it('shows no callout when every finished machine is reporting', () => {
    useLovelyActivityMock.mockReturnValue({
      entries: [entry(neverOnline, 'online')], nowMs: NOW, telemetryError: null,
    });
    render(<OnboardingTab onGoToVerification={vi.fn()} />);
    expect(screen.queryByText(/finished setup 3\+ days/)).toBeNull();
  });

  it('says why nothing is flagged when machine status failed to load', () => {
    useLovelyActivityMock.mockReturnValue({ entries: [], nowMs: NOW, telemetryError: 'timeout' });
    render(<OnboardingTab onGoToVerification={vi.fn()} />);
    expect(screen.getByText(/Machine status is unavailable \(timeout\)/)).toBeInTheDocument();
  });

  it('shows "Not tracked" for customers mid-setup before step times existed', () => {
    useLovelyUsersMock.mockReturnValue({
      users: [mk({ id: 'o', first_name: 'Olive', onboarding_step: 'quiz_done', onboarding_step_at: null })],
      loading: false, error: null, refetch: vi.fn(),
    });
    useLovelyActivityMock.mockReturnValue({ entries: [], nowMs: NOW, telemetryError: null });
    render(<OnboardingTab onGoToVerification={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Preference quiz/ }));
    expect(within(screen.getByRole('table')).getByText('Not tracked')).toBeInTheDocument();
  });
});
