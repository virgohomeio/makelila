import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { InterviewsTab } from '../InterviewsTab';
import {
  useCandidates, useInterviews, useShortlistedCandidates, markScreeningInviteSent,
  type Candidate, type JobPosting,
} from '../../../lib/hiring';
import { useEmailTemplate, useSchedulingUrl, type EmailTemplate } from '../../../lib/templates';

vi.mock('../../../lib/hiring', () => ({
  useJobPostings: vi.fn(() => ({ postings: [posting], loading: false })),
  useCandidates: vi.fn(() => ({ candidates: [], loading: false })),
  useShortlistedCandidates: vi.fn(() => ({ candidates: [], loading: false })),
  useInterviews: vi.fn(() => ({ interviews: [], loading: false })),
  createInterview: vi.fn(),
  recordInterviewDecision: vi.fn(),
  markScreeningInviteSent: vi.fn(async () => {}),
  getCurrentUserId: vi.fn(),
}));

// renderTemplate is pure string substitution — the real one is kept here rather
// than stubbed, so these tests exercise the same rendering the app ships.
// No default return here: vi.mock factories are hoisted above the const below,
// so referencing it at factory time would hit the temporal dead zone. beforeEach
// seeds the return value instead.
vi.mock('../../../lib/templates', () => ({
  useEmailTemplate: vi.fn(),
  useSchedulingUrl: vi.fn(),
  renderTemplate: (template: string, vars: Record<string, string | undefined>) =>
    template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
      const v = vars[name];
      return v === undefined || v === null || v === '' ? `{{${name}}}` : String(v);
    }),
}));

// Body matches the shipped copy after 20260804140200 dropped the corporate
// sign-off — the invite goes out under the operator's own signature.
const screeningTemplate: EmailTemplate = {
  id: 't1', key: 'screening_interview_invite', name: 'Screening interview invite',
  category: 'support', description: null,
  subject: 'Screening interview for the {{job_title}} role at VCycene',
  body: 'Hi {{candidate_first_name}},\n\nPlease pick a time that works for you here:\n{{scheduling_url}}\n\nLooking forward to speaking with you.',
  variables: ['candidate_first_name', 'job_title', 'scheduling_url'],
  channel: 'email', active: true,
  created_at: '2026-08-04T00:00:00Z', updated_at: '2026-08-04T00:00:00Z',
};

const posting: JobPosting = {
  id: 'p1', title: 'Fulfillment Associate', department: null, location: null, comp_range: null,
  status: 'open', indeed_url: null, linkedin_url: null, job_description: null,
  screening_rubric: [], pipeline_stages: ['Applied', 'Screen', 'Interview'],
  created_at: '2026-07-01T00:00:00Z',
};

function candidate(over: Partial<Candidate> & { id: string; full_name: string }): Candidate {
  return {
    posting_id: 'p1', email: null, phone: null,
    source: 'indeed', resume_url: 'p1/resume.pdf', ingested_via: 'manual_upload',
    enrichment_status: 'resume_attached', indeed_relay_email: null, indeed_dashboard_url: null,
    qualifications_tags: [], stage_index: 0, scores: {}, suggested_scores: null,
    applied_at: '2026-07-01T00:00:00Z', rejected_at: null, hired_at: null,
    screening_invite_sent_at: null, screening_invite_sent_by: null,
    ...over,
  };
}

function withCandidates(candidates: Candidate[]) {
  vi.mocked(useCandidates).mockReturnValue({ candidates, loading: false });
}

// jsdom has no clipboard API; the copy button needs one to call.
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: vi.fn(async () => {}) }, configurable: true,
});

// clearAllMocks() wipes recorded calls but keeps mockReturnValue overrides, so
// the per-test hook stubs are re-seeded to their defaults here.
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(useInterviews).mockReturnValue({ interviews: [], loading: false });
  vi.mocked(useEmailTemplate).mockReturnValue({ template: screeningTemplate, loading: false });
  vi.mocked(useShortlistedCandidates).mockReturnValue({ candidates: [], loading: false });
  vi.mocked(useSchedulingUrl).mockReturnValue({ schedulingUrl: null, loading: false, save: vi.fn() });
});

describe('InterviewsTab candidate list', () => {
  it('lists only shortlisted candidates', () => {
    withCandidates([
      candidate({ id: 'c1', full_name: 'Shortlisted Sam', hired_at: '2026-07-30T00:00:00Z' }),
      candidate({ id: 'c2', full_name: 'Undecided Uma' }),
      candidate({ id: 'c3', full_name: 'Rejected Rita', rejected_at: '2026-07-30T00:00:00Z' }),
    ]);
    render(<InterviewsTab />);
    expect(screen.getByText('Shortlisted Sam')).toBeTruthy();
    expect(screen.queryByText('Undecided Uma')).toBeNull();
    expect(screen.queryByText('Rejected Rita')).toBeNull();
  });

  it('excludes stub candidates even when shortlisted', () => {
    withCandidates([
      candidate({
        id: 'c1', full_name: 'Stub Steve', enrichment_status: 'stub',
        hired_at: '2026-07-30T00:00:00Z',
      }),
    ]);
    render(<InterviewsTab />);
    expect(screen.queryByText('Stub Steve')).toBeNull();
  });

  it('counts only the shortlisted candidates in the column header', () => {
    withCandidates([
      candidate({ id: 'c1', full_name: 'Shortlisted Sam', hired_at: '2026-07-30T00:00:00Z' }),
      candidate({ id: 'c2', full_name: 'Undecided Uma' }),
    ]);
    render(<InterviewsTab />);
    expect(screen.getByText('· 1')).toBeTruthy();
  });

  it('shows the saved scores as text beside the candidate name', () => {
    withCandidates([
      candidate({
        id: 'c1', full_name: 'Shortlisted Sam', hired_at: '2026-07-30T00:00:00Z',
        scores: { Communication: 4, Reliability: 5 },
      }),
    ]);
    render(<InterviewsTab />);
    expect(screen.getByText('Communication 4 · Reliability 5')).toBeTruthy();
  });

  it('falls back to suggested scores, with saved scores taking precedence', () => {
    withCandidates([
      candidate({
        id: 'c1', full_name: 'Shortlisted Sam', hired_at: '2026-07-30T00:00:00Z',
        suggested_scores: { Communication: 2, Reliability: 3 },
        scores: { Communication: 4 },
      }),
    ]);
    render(<InterviewsTab />);
    expect(screen.getByText('Communication 4 · Reliability 3')).toBeTruthy();
  });

  it('says so when a shortlisted candidate has no scores yet', () => {
    withCandidates([
      candidate({ id: 'c1', full_name: 'Shortlisted Sam', hired_at: '2026-07-30T00:00:00Z' }),
    ]);
    render(<InterviewsTab />);
    expect(screen.getByText('No scores yet')).toBeTruthy();
  });

  it('shows the candidate email beside the name', () => {
    withCandidates([shortlisted({ email: 'sam@example.com' })]);
    render(<InterviewsTab />);
    expect(screen.getByText('sam@example.com')).toBeTruthy();
  });

  it('falls back to the Indeed relay email when there is no direct email', () => {
    withCandidates([shortlisted({ email: null, indeed_relay_email: 'relay+sam@indeedemail.com' })]);
    render(<InterviewsTab />);
    expect(screen.getByText('relay+sam@indeedemail.com')).toBeTruthy();
  });

  it('says so when no email is on file', () => {
    withCandidates([shortlisted({ email: null, indeed_relay_email: null })]);
    render(<InterviewsTab />);
    expect(screen.getByText('No email on file')).toBeTruthy();
  });
});

function shortlisted(over: Partial<Candidate> = {}): Candidate {
  return candidate({
    id: 'c1', full_name: 'Shortlisted Sam', email: 'sam@example.com',
    hired_at: '2026-07-30T00:00:00Z', ...over,
  });
}

/** Opens the per-candidate panel, where the screening-invite draft lives. */
function expandCandidate(name = 'Shortlisted Sam') {
  fireEvent.click(screen.getByText(name));
  return screen.getByRole('heading', { name: `Interviews — ${name}` }).parentElement as HTMLElement;
}

describe('InterviewsTab screening invite draft', () => {
  it('fills the candidate first name and role into the template', () => {
    withCandidates([shortlisted()]);
    render(<InterviewsTab />);
    const panel = expandCandidate();

    expect(within(panel).getByText('Subject: Screening interview for the Fulfillment Associate role at VCycene')).toBeTruthy();
    expect(within(panel).getByText(/Hi Shortlisted,/)).toBeTruthy();
  });

  it('fills in the scheduling link saved on the operator profile', () => {
    vi.mocked(useSchedulingUrl).mockReturnValue({
      schedulingUrl: 'https://calendly.com/huayi/screening', loading: false, save: vi.fn(),
    });
    withCandidates([shortlisted()]);
    render(<InterviewsTab />);
    const panel = expandCandidate();

    expect(within(panel).getByText(/https:\/\/calendly\.com\/huayi\/screening/)).toBeTruthy();
    expect(within(panel).queryByText(/paste your scheduling link/)).toBeNull();
  });

  it('falls back to a paste-it-here marker when no scheduling link is saved', () => {
    withCandidates([shortlisted()]);
    render(<InterviewsTab />);
    const panel = expandCandidate();

    expect(within(panel).getByText(/\[paste your scheduling link here\]/)).toBeTruthy();
    expect(within(panel).queryByText(/\{\{scheduling_url\}\}/)).toBeNull();
  });

  it('copies the address, subject and body to the clipboard', async () => {
    withCandidates([shortlisted({ email: 'sam@example.com' })]);
    render(<InterviewsTab />);
    const panel = expandCandidate();

    fireEvent.click(within(panel).getByRole('button', { name: 'Copy email' }));

    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(copied).toContain('To: sam@example.com');
    expect(copied).toContain('Screening interview for the Fulfillment Associate role at VCycene');
    expect(copied).toContain('Hi Shortlisted,');
    expect(copied).toContain('[paste your scheduling link here]');
    expect(await within(panel).findByText('Email copied')).toBeTruthy();
  });

  it('copies the recipient address on its own', async () => {
    withCandidates([shortlisted({ email: 'sam@example.com' })]);
    render(<InterviewsTab />);
    const panel = expandCandidate();

    fireEvent.click(within(panel).getByRole('button', { name: 'Copy address' }));

    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0][0]).toBe('sam@example.com');
    expect(await within(panel).findByText('Address copied')).toBeTruthy();
  });

  it('cannot copy an address that is not on file', () => {
    withCandidates([shortlisted({ email: null, indeed_relay_email: null })]);
    render(<InterviewsTab />);
    const panel = expandCandidate();

    const button = within(panel).getByRole('button', { name: 'Copy address' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('addresses the copy to the Indeed relay when there is no direct email', () => {
    withCandidates([shortlisted({ email: null, indeed_relay_email: 'relay+sam@indeedemail.com' })]);
    render(<InterviewsTab />);
    const panel = expandCandidate();

    fireEvent.click(within(panel).getByRole('button', { name: 'Copy email' }));
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0][0]).toContain('To: relay+sam@indeedemail.com');
  });

  // makeLILA hands over text, nothing else — no mail client is launched and
  // nothing is sent, so copying can't imply the candidate was contacted.
  it('opens no mail client and marks nothing on copy', () => {
    withCandidates([shortlisted()]);
    render(<InterviewsTab />);
    const panel = expandCandidate();

    fireEvent.click(within(panel).getByRole('button', { name: 'Copy email' }));

    expect(within(panel).queryByRole('button', { name: /send/i })).toBeNull();
    expect(markScreeningInviteSent).not.toHaveBeenCalled();
  });

  it('lets the operator clear a sent marker set by mistake', async () => {
    withCandidates([shortlisted({ screening_invite_sent_at: '2026-08-04T12:00:00Z' })]);
    render(<InterviewsTab />);
    const panel = expandCandidate();

    fireEvent.click(within(panel).getByRole('button', { name: 'Mark not emailed' }));

    expect(markScreeningInviteSent).toHaveBeenCalledWith('c1', false);
    expect(await within(panel).findByRole('button', { name: 'Mark emailed' })).toBeTruthy();
  });

  it('shows on the candidate row whether the invite went out', () => {
    withCandidates([
      shortlisted({ id: 'c1', full_name: 'Emailed Eve', screening_invite_sent_at: '2026-08-04T12:00:00Z' }),
      shortlisted({ id: 'c2', full_name: 'Waiting Wes' }),
    ]);
    render(<InterviewsTab />);

    // Scoped to the candidate card: the outreach panel above the board carries
    // an "Emailed" stat label too.
    const card = (name: string) => screen.getByText(name).closest('div') as HTMLElement;
    expect(within(card('Emailed Eve')).getByText('Emailed')).toBeTruthy();
    expect(within(card('Waiting Wes')).getByText('Not emailed')).toBeTruthy();
  });

  it('says so when the screening template is missing from the library', () => {
    withCandidates([shortlisted()]);
    vi.mocked(useEmailTemplate).mockReturnValue({ template: null, loading: false });
    render(<InterviewsTab />);
    const panel = expandCandidate();

    expect(within(panel).getByText(/Screening interview invite template not found/)).toBeTruthy();
  });
});
