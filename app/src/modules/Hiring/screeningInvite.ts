import { renderTemplate, type EmailTemplate } from '../../lib/templates';
import type { Candidate } from '../../lib/hiring';

/** Shared by the Interviews board and the outreach panel — both render the
 *  same invite for the same candidate, so the copy, the variable set and the
 *  "where do we reach this person" rule live in one place. */

export const SCREENING_TEMPLATE_KEY = 'screening_interview_invite';

/** Stands in for {{scheduling_url}} when the operator has not saved a booking
 *  link on their profile yet. A bracketed instruction reads as an obvious to-do
 *  in a way a leftover {{scheduling_url}} does not. Saving a link on the
 *  outreach panel replaces this everywhere. */
export const SCHEDULING_URL_PLACEHOLDER = '[paste your scheduling link here]';

export type InviteDraft = { subject: string; body: string };

/** Where to reach the candidate. Indeed applicants often have no direct
 *  address — only the relay Indeed forwards from — so fall back to it, the
 *  same order the Applicants board displays. */
export function candidateEmail(candidate: Pick<Candidate, 'email' | 'indeed_relay_email'>): string | null {
  return candidate.email ?? candidate.indeed_relay_email;
}

export function renderScreeningInvite(
  template: EmailTemplate,
  input: { candidateName: string; postingTitle: string; schedulingUrl: string | null },
): InviteDraft {
  const vars = {
    candidate_first_name: input.candidateName.split(' ')[0],
    job_title: input.postingTitle,
    scheduling_url: input.schedulingUrl?.trim() || SCHEDULING_URL_PLACEHOLDER,
  };
  return {
    subject: renderTemplate(template.subject, vars),
    body: renderTemplate(template.body, vars),
  };
}
