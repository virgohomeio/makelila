// Shared Google Calendar helpers (service-account / domain-wide-delegation).
//
// Originally inlined in sync-calendly-events (Backlog #44); extracted here so
// multiple edge functions can reuse the auth + event helpers. The service
// account's DWD must include the calendar scope:
//   https://www.googleapis.com/auth/calendar.events
//
// Env (caller-provided): GOOGLE_SERVICE_ACCOUNT_KEY (base64 SA JSON).

import { SignJWT, importPKCS8 } from 'https://esm.sh/jose@5.9.6';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri: string;
};

export type CalendarAttendee = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
};

export type CalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: CalendarAttendee[];
  status?: string;
};

export async function getCalendarAccessToken(
  saKey: ServiceAccountKey, delegatedSubject: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(saKey.private_key, 'RS256');
  const assertion = await new SignJWT({ scope: CALENDAR_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(saKey.client_email)
    .setSubject(delegatedSubject)
    .setAudience(saKey.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch(saKey.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json() as { access_token?: string };
  if (!json.access_token) throw new Error('Google token endpoint returned no access_token');
  return json.access_token;
}

/** List events from a calendar (delegated subject) in [timeMin,timeMax], single-expanded. */
export async function listCalendarEvents(
  accessToken: string, calendarId: string, timeMin: string, timeMax: string,
): Promise<Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string }; attendees?: Array<{ email?: string; displayName?: string; organizer?: boolean; self?: boolean }> }>> {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '250');
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`calendar list ${res.status}: ${await res.text()}`);
  return (await res.json()).items ?? [];
}

/** Locate the Google Calendar event Calendly created for a given
 *  scheduled-event start time + invitee email. We list events in a
 *  ±2 minute window around the Calendly start time and pick the first
 *  one whose attendee list contains the customer's email. ±2 min covers
 *  small clock skew between Calendly's stored time and Google's stored
 *  time without grabbing adjacent bookings. */
export async function findCalendlyEventOnCalendar(
  accessToken: string,
  calendarId: string,
  calendlyStartIso: string,
  customerEmail: string | null,
): Promise<CalendarEvent | null> {
  const startMs = Date.parse(calendlyStartIso);
  const timeMin = new Date(startMs - 2 * 60 * 1000).toISOString();
  const timeMax = new Date(startMs + 2 * 60 * 1000).toISOString();

  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '20');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Calendar events.list ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json() as { items?: CalendarEvent[] };
  const items = (json.items ?? []).filter(e => e.status !== 'cancelled');

  if (customerEmail) {
    const target = customerEmail.toLowerCase();
    const match = items.find(e =>
      (e.attendees ?? []).some(a => (a.email ?? '').toLowerCase() === target)
    );
    if (match) return match;
  }

  // No customer email available, or no attendee match: fall back to the
  // single closest event by start-time delta (only safe when there's
  // exactly one event in the window).
  if (items.length === 1) return items[0];
  return null;
}

/** PATCH the event's attendees array to include the new attendees. Any
 *  emails already on the list are silently de-duped. sendUpdates=all
 *  fires the standard Google Calendar invite email to the *added*
 *  attendees only. */
export async function addAttendeesToCalendarEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  existingAttendees: CalendarAttendee[],
  newAttendeeEmails: string[],
): Promise<void> {
  const existingLower = new Set(
    existingAttendees.map(a => (a.email ?? '').toLowerCase()).filter(Boolean)
  );
  const toAdd: CalendarAttendee[] = newAttendeeEmails
    .filter(e => !existingLower.has(e.toLowerCase()))
    .map(email => ({ email }));
  if (toAdd.length === 0) return;  // already on the event — no-op

  // Strip fields Google rejects on write (organizer/self echo back is
  // fine; responseStatus would force a reset of the customer's response).
  const cleanAttendees = [...existingAttendees, ...toAdd]
    .filter(a => a.email)
    .map(a => ({ email: a.email!, displayName: a.displayName, responseStatus: a.responseStatus }));

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ attendees: cleanAttendees }),
  });
  if (!res.ok) {
    throw new Error(`Calendar events.patch ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}
