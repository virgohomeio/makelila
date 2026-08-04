import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { OutreachPanel } from '../OutreachPanel';
import { useShortlistedCandidates, markScreeningInviteSent, type ShortlistedCandidate } from '../../../lib/hiring';
import { useEmailTemplate, useSchedulingUrl, type EmailTemplate } from '../../../lib/templates';

vi.mock('../../../lib/hiring', () => ({
  useShortlistedCandidates: vi.fn(),
  markScreeningInviteSent: vi.fn(async () => {}),
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

// jsdom has no clipboard API; the copy buttons need one to call.
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: vi.fn(async () => {}) }, configurable: true,
});

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
  vi.mocked(useEmailTemplate).mockReturnValue({ template, loading: false });
  vi.mocked(useSchedulingUrl).mockReturnValue({ schedulingUrl: null, loading: false, save: vi.fn() });
  withShortlist([]);
});

/** The row for one candidate in the outreach table. */
function row(name: string): HTMLElement {
  return screen.getByText(name).closest('tr') as HTMLElement;
}

const copiedText = () => vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];

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
  });

  it('copies that candidate invite, addressed and filled in', async () => {
    vi.mocked(useSchedulingUrl).mockReturnValue({
      schedulingUrl: 'https://calendly.com/huayi/screening', loading: false, save: vi.fn(),
    });
    withShortlist([shortlisted({ id: 'c1', full_name: 'Sam Chen' })]);
    render(<OutreachPanel />);

    fireEvent.click(within(row('Sam Chen')).getByRole('button', { name: 'Copy email' }));

    expect(copiedText()).toBe(
      'To: sam@example.com\n' +
      'Subject: Screening interview for the Fulfillment Associate role at VCycene\n\n' +
      'Hi Sam,\n\nBook a time: https://calendly.com/huayi/screening'
    );
    expect(await within(row('Sam Chen')).findByText('Copied')).toBeTruthy();
  });

  it('addresses the copy to the Indeed relay when there is no direct email', () => {
    withShortlist([shortlisted({
      id: 'c1', full_name: 'Sam Chen', email: null, indeed_relay_email: 'relay+sam@indeedemail.com',
    })]);
    render(<OutreachPanel />);

    fireEvent.click(within(row('Sam Chen')).getByRole('button', { name: 'Copy email' }));
    expect(copiedText()).toContain('To: relay+sam@indeedemail.com');
  });

  // Copying is not sending — the operator still has to paste and send, so the
  // sent marker stays an explicit action rather than a side effect of copying.
  it('does not mark the candidate emailed just for copying', () => {
    withShortlist([shortlisted({ id: 'c1', full_name: 'Sam Chen' })]);
    render(<OutreachPanel />);

    fireEvent.click(within(row('Sam Chen')).getByRole('button', { name: 'Copy email' }));
    expect(markScreeningInviteSent).not.toHaveBeenCalled();
  });

  it('copies the invite body alone when no address is on file', () => {
    withShortlist([shortlisted({ id: 'c1', full_name: 'Sam Chen', email: null, indeed_relay_email: null })]);
    render(<OutreachPanel />);

    const r = row('Sam Chen');
    expect(within(r).getByText('No email on file')).toBeTruthy();
    fireEvent.click(within(r).getByRole('button', { name: 'Copy email' }));
    expect(copiedText().startsWith('Subject: ')).toBe(true);
  });

  it('lets the operator record an invite as sent, and undo it', async () => {
    withShortlist([shortlisted({ id: 'c1', full_name: 'Sam Chen' })]);
    render(<OutreachPanel />);

    fireEvent.click(within(row('Sam Chen')).getByRole('button', { name: 'Mark emailed' }));
    expect(markScreeningInviteSent).toHaveBeenCalledWith('c1', true);

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
