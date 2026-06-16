// Feature 3: bidirectional Linear/GitHub issue linking from Service tickets.
// These functions call edge functions (not the APIs directly) so that
// LINEAR_API_KEY and GITHUB_PAT never reach the operator's browser.
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';
import type { ServiceTicket } from './service';

async function callEdgeFunction(
  fnName: string,
  body: Record<string, unknown>,
): Promise<{ url: string; identifier?: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token ?? ''}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `${fnName} failed (${res.status})`);
  }
  return res.json() as Promise<{ url: string; identifier?: string }>;
}

export async function createLinearIssue(
  ticket: ServiceTicket,
  opts: { teamKey: string; title: string; description: string },
): Promise<{ url: string; identifier: string }> {
  const result = await callEdgeFunction('linear-create-issue', {
    ticket_id: ticket.id,
    team_key: opts.teamKey,
    title: opts.title,
    description: opts.description,
  });
  return { url: result.url, identifier: result.identifier ?? '' };
}

export async function createGitHubIssue(
  ticket: ServiceTicket,
  opts: { repo: string; title: string; body: string },
): Promise<{ url: string }> {
  return callEdgeFunction('github-create-issue', {
    ticket_id: ticket.id,
    repo: opts.repo,
    title: opts.title,
    body: opts.body,
  });
}
