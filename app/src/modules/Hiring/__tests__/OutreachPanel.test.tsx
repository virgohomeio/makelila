import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { OutreachPanel } from '../OutreachPanel';
import {
  useShortlistedCandidates, markScreeningInviteSent, useOperatorEmails, type ShortlistedCandidate,
} from '../../../lib/hiring';
import { useEmailTemplate, useSchedulingUrl, type EmailTemplate } from '../../../lib/templates';
import { openMailDraft } from '../../../lib/mailDraft';
import { useAuth } from '../../../lib/auth';

vi.mock('../../../lib/hiring', () => ({
  useShortlistedCandidates: vi.fn(),
  markScreeningInviteSent: vi.fn(async () => {}),
  useOperatorEmails: vi.fn(),
}));

vi.mock('../../../lib/templates', () => ({
  useEmailTemplate: vi.fn(),
  useSchedulingUrl: vi.fn(),
  renderTemplate: (template: string, vars: Record<string, string | undefined>) =>
    template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
      const v = vars[name];
      return v === undefined || v === null || v === '' ? `{{${name}}}` : String(v);
    }),
}));

vi.mock('../../../lib/mailDraft', () => ({ openMailDraft: vi.fn() }));

// The panel composes as the signed-in operator; this renders it outside an
// AuthProvider, so the context read is stubbed. Seeded per test in beforeEach
// so a test can drop the address and exercise the mailto fallback labelling.
vi.mock('../../../lib/auth', () => ({ useAuth: vi.fn() }));

const template: EmailTemplate = {
  id: 't1', key: 'screening_interview_invite', name: 'Screening interview invite',
  category: 'support', description: null,
  subject: 'Screening interview for the {{job_title}} role at VCycene',
  body: 'Hi {{candidate_first_name}},\n\nBook a time: {{scheduling_url}}',
  variables: ['candidate_first_name', 'job_title', 'scheduling_url'],
  channel: 'email', active: true,
  created_at: '2026-08-04T00:00:00Z', updated_at: '2026-08-04T00:00:00Z',
};

function shortlisted(over: Partial<ShortlistedCandidate> & { id: string; full_name: string }): ShortlistedCandidate {
  return {
    posting_id: 'p1', posting_title: 'Fulfillment Associate',
    email: 'sam@example.com', phone: null, source: 'indeed',
    resume_url: 'p1/resume.pdf', ingested_via: 'manual_upload', enrichment_status: 'resume_attached',
    indeed_relay_email: null, indeed_dashboard_url: null, qualifications_tags: [],
    stage_index: 0, scores: {}, suggested_scores: null,
    applied_at: '2026-07-01T00:00:00Z', rejected_at: null, hired_at: '2026-07-30T00:00:00Z',
    screening_invite_sent_at: null, screening_invite_sent_by: null,
    ...over,
  };
}

function withShortlist(candidates: ShortlistedCandidate[]) {
  vi.mocked(useShortlistedCandidates).mockReturnValue({ candidates, loading: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The chosen sender is remembered in localStorage — clear it so each test
  // starts from "no choice made yet" and falls back to the signed-in account.
  localStorage.clear();
  vi.mocked(useAuth).mockReturnValue({ user: { email: 'huayi@virgohome.io' } } as unknown as ReturnType<typeof useAuth>);
  vi.mocked(useOperatorEmails).mockReturnValue({
    emails: ['huayi@virgohome.io', 'junaid@virgohome.io', 'pedrum@virgohome.io'], loading: false,
  });
  vi.mocked(useEmailTemplate).mockReturnValue({ template, loading: false });
  vi.mocked(useSchedulingUrl).mockReturnValue({ schedulingUrl: null, loading: false, save: vi.fn() });
  withShortlist([]);
});

/** The row for one candidate in the outreach table. */
function row(name: string): HTMLElement {
  return screen.getByText(name).closest('tr') as HTMLElement;
}

describe('OutreachPanel counts', () => {
  it('splits the shortlist into emailed and awaiting', () => {
    withShortlist([
      shortlisted({ id: 'c1', full_name: 'Emailed Eve', screening_invite_sent_at: '2026-08-04T12:00:00Z' }),
      shortlisted({ id: 'c2', full_name: 'Waiting Wes' }),
      shortlisted({ id: 'c3', full_name: 'Waiting Wanda' }),
    ]);
    render(<OutreachPanel />);

    const stat = (label: string) =>
      screen.getByText(label).parentElement?.querySelector('div')?.textContent;
    expect(stat('Shortlisted')).toBe('3');
    expect(stat('Emailed')).toBe('1');
    expect(stat('Awaiting email')).toBe('2');
    expect(screen.getByText('33% contacted')).toBeTruthy();
  });

  // Gmail only shows a From line on accounts with multiple send-as addresses,
  // so the compose tab often can't answer "who am I sending as" — makeLILA says
  // it here, before the click.
  it('defaults the sending account to the signed-in operator', () => {
    render(<OutreachPanel />);
    expect((screen.getByLabelText('Sending as') as HTMLSelectElement).value).toBe('huayi@virgohome.io');
  });

  it('offers the other internal operators as senders', () => {
    render(<OutreachPanel />);
    const options = Array.from((screen.getByLabelText('Sending as') as HTMLSelectElement).options).map(o => o.value);
    expect(options).toContain('junaid@virgohome.io');
    expect(options).toContain('pedrum@virgohome.io');
  });

  it('drafts as the chosen account rather than the signed-in one', () => {
    withShortlist([shortlisted({ id: 'c1', full_name: 'Sam Chen' })]);
    render(<OutreachPanel />);

    fireEvent.change(screen.getByLabelText('Sending as'), { target: { value: 'junaid@virgohome.io' } });
    fireEvent.click(within(row('Sam Chen')).getByRole('button', { name: 'Send as junaid@virgohome.io' }));

    expect(openMailDraft).toHaveBeenCalledWith(expect.objectContaining({ from: 'junaid@virgohome.io' }));
  });

  it('remembers the chosen sender across a remount', () => {
    const first = render(<OutreachPanel />);
    fireEvent.change(screen.getByLabelText('Sending as'), { target: { value: 'junaid@virgohome.io' } });
    first.unmount();

    render(<OutreachPanel />);
    expect((screen.getByLabelText('Sending as') as HTMLSelectElement).value).toBe('junaid@virgohome.io');
  });

  // A remembered address that is no longer a colleague (someone left) must not
  // silently keep addressing mail from an account nobody can open.
  it('falls back to the signed-in account when the remembered sender is gone', () => {
    localStorage.setItem('makelila.hiring.sendingAs', 'departed@virgohome.io');
    render(<OutreachPanel />);
    expect((screen.getByLabelText('Sending as') as HTMLSelectElement).value).toBe('huayi@virgohome.io');
  });

  it('says the draft opens in the operator default mail client when no account is known', () => {
    vi.mocked(useAuth).mockReturnValue({ user: null } as unknown as ReturnType<typeof useAuth>);
    vi.mocked(useOperatorEmails).mockReturnValue({ emails: [], loading: false });
    withShortlist([shortlisted({ id: 'c1', full_name: 'Sam Chen' })]);
    render(<OutreachPanel />);

    expect(screen.getByText('Sending from your default mail client')).toBeTruthy();
    expect(within(row('Sam Chen')).getByRole('button', { name: 'Send email' })).toBeTruthy();
  });

  it('says so when nobody is shortlisted yet', () => {
    render(<OutreachPanel />);
    expect(screen.getByText(/No shortlisted candidates yet/)).toBeTruthy();
  });
});

describe('OutreachPanel rows', () => {
  it('shows each candidate with their role, address and invite state', () => {
    withShortlist([shortlisted({ id: 'c1', full_name: 'Sam Chen' })]);
    render(<OutreachPanel />);

    const r = row('Sam Chen');
    expect(within(r).getByText('Fulfillment Associate')).toBeTruthy();
    expect(within(r).getByText('sam@example.com')).toBeTruthy();
    expect(within(r).getByText('Not emailed')).toBeTruthy();
  });

  it('marks an already-emailed candidate with the date it went out', () => {
    withShortlist([shortlisted({
      id: 'c1', full_name: 'Sam Chen', screening_invite_sent_at: '2026-08-04T12:00:00Z',
    })]);
    render(<OutreachPanel />);

    expect(within(row('Sam Chen')).getByText(/^Emailed /)).toBeTruthy();
    expect(within(row('Sam Chen')).getByRole('button', { name: 'Send again as huayi@virgohome.io' })).toBeTruthy();
  });

  it('opens a draft and records the outreach in one click', async () => {
    vi.mocked(useSchedulingUrl).mockReturnValue({
      schedulingUrl: 'https://calendly.com/huayi/screening', loading: false, save: vi.fn(),
    });
    withShortlist([shortlisted({ id: 'c1', full_name: 'Sam Chen' })]);
    render(<OutreachPanel />);

    fireEvent.click(within(row('Sam Chen')).getByRole('button', { name: 'Send as huayi@virgohome.io' }));

    expect(openMailDraft).toHaveBeenCalledWith({
      from: 'huayi@virgohome.io',
      to: 'sam@example.com',
      subject: 'Screening interview for the Fulfillment Associate role at VCycene',
      body: 'Hi Sam,\n\nBook a time: https://calendly.com/huayi/screening',
    });
    expect(markScreeningInviteSent).toHaveBeenCalledWith('c1', true);
    expect(await within(row('Sam Chen')).findByText(/^Emailed /)).toBeTruthy();
  });

  it('cannot draft to a candidate with no address on file', () => {
    withShortlist([shortlisted({ id: 'c1', full_name: 'Sam Chen', email: null, indeed_relay_email: null })]);
    render(<OutreachPanel />);

    const r = row('Sam Chen');
    expect(within(r).getByText('No email on file')).toBeTruthy();
    expect(within(r).getByRole('button', { name: 'Send as huayi@virgohome.io' }).hasAttribute('disabled')).toBe(true);
  });

  it('lets the operator confirm an invite sent some other way, and undo it', async () => {
    withShortlist([shortlisted({ id: 'c1', full_name: 'Sam Chen' })]);
    render(<OutreachPanel />);

    fireEvent.click(within(row('Sam Chen')).getByRole('button', { name: 'Mark emailed' }));

    expect(markScreeningInviteSent).toHaveBeenCalledWith('c1', true);
    expect(openMailDraft).not.toHaveBeenCalled();

    fireEvent.click(await within(row('Sam Chen')).findByRole('button', { name: 'Mark not emailed' }));
    expect(markScreeningInviteSent).toHaveBeenLastCalledWith('c1', false);
  });

  it('surfaces a failed status write instead of showing a state that did not save', async () => {
    vi.mocked(markScreeningInviteSent).mockRejectedValueOnce(new Error('RLS denied the update'));
    withShortlist([shortlisted({ id: 'c1', full_name: 'Sam Chen' })]);
    render(<OutreachPanel />);

    fireEvent.click(within(row('Sam Chen')).getByRole('button', { name: 'Mark emailed' }));

    expect(await screen.findByText('RLS denied the update')).toBeTruthy();
    expect(within(row('Sam Chen')).getByText('Not emailed')).toBeTruthy();
  });
});

describe('OutreachPanel scheduling link', () => {
  it('seeds the input with the link already saved on the profile', () => {
    vi.mocked(useSchedulingUrl).mockReturnValue({
      schedulingUrl: 'https://calendly.com/huayi/screening', loading: false, save: vi.fn(),
    });
    render(<OutreachPanel />);

    expect((screen.getByLabelText('Your scheduling link') as HTMLInputElement).value)
      .toBe('https://calendly.com/huayi/screening');
  });

  it('saves a pasted link to the operator account', async () => {
    const save = vi.fn(async () => {});
    vi.mocked(useSchedulingUrl).mockReturnValue({ schedulingUrl: null, loading: false, save });
    render(<OutreachPanel />);

    fireEvent.change(screen.getByLabelText('Your scheduling link'), {
      target: { value: 'https://calendly.com/huayi/screening' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(save).toHaveBeenCalledWith('https://calendly.com/huayi/screening');
    expect(await screen.findByText(/Saved/)).toBeTruthy();
  });
});
