// What sendEzTransBooking actually puts on the wire.
//
// The edge function decides which document to use by which fields are PRESENT
// in the request: a missing `subject`/`body` means "read the saved template",
// and a missing `packing_list` means the same for the picking document. So the
// shape of this request is the whole contract — a field sent when nothing was
// edited silently overrides the saved template, and a field dropped when
// something was edited silently sends the 3PL the stock document instead.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 't' } } }) } },
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
}));

import { sendEzTransBooking } from './eztrans';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    text: () => Promise.resolve(JSON.stringify({ email_id: 're_1' })),
  });
  vi.stubGlobal('fetch', fetchMock);
});

/** The JSON body of the one call made. */
function sentBody(): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
}

describe('sendEzTransBooking request shape', () => {
  it('sends neither document when nothing was edited', async () => {
    await sendEzTransBooking('q-1');
    expect(sentBody()).toEqual({ queue_id: 'q-1' });
  });

  it('sends only the packing list when only the packing list was edited', async () => {
    // A copy of the rendered wording sent here would look like an operator
    // edit to the edge function, which would then skip the email_templates
    // lookup entirely — throwing away wording saved in the Templates tab.
    await sendEzTransBooking('q-1', { packing_list: '# PICK LIST' });
    const body = sentBody();
    expect(body.packing_list).toBe('# PICK LIST');
    expect(body).not.toHaveProperty('subject');
    expect(body).not.toHaveProperty('body');
  });

  it('sends only the wording when only the wording was edited', async () => {
    await sendEzTransBooking('q-1', { subject: 'RUSH', body: 'Please expedite.' });
    const body = sentBody();
    expect(body.subject).toBe('RUSH');
    expect(body.body).toBe('Please expedite.');
    expect(body).not.toHaveProperty('packing_list');
  });

  it('still sends a packing list the operator cleared, so the server can refuse it', async () => {
    // Dropped as falsy, the edge function sees no override, falls back to the
    // stock document and mails it to the 3PL — while its own "an edited
    // packing list cannot be empty" guard never runs. An empty document is an
    // error to show the operator, not a reason to send a different one.
    await sendEzTransBooking('q-1', { packing_list: '' });
    expect(sentBody().packing_list).toBe('');
  });

  it('still sends wording the operator cleared, so the server can refuse it', async () => {
    await sendEzTransBooking('q-1', { subject: '', body: '' });
    const body = sentBody();
    expect(body.subject).toBe('');
    expect(body.body).toBe('');
  });
});
