/** True if the event title contains the diagnosis marker (case-insensitive). */
export function matchesDiagnosisTitle(summary: string | undefined, needle: string): boolean {
  return !!summary && summary.toLowerCase().includes(needle.toLowerCase());
}

/** True if a candidate call duplicates an existing diagnosis ticket: same
 *  customer email AND start within ±15 minutes (covers calls that also came
 *  in via Calendly). */
export function isDuplicateOf(
  cand: { email: string | null; startIso: string },
  existing: Array<{ customer_email: string | null; calendly_event_start: string | null }>,
): boolean {
  const t = new Date(cand.startIso).getTime();
  const email = (cand.email ?? '').toLowerCase().trim();
  if (!email) return false;
  return existing.some(e =>
    (e.customer_email ?? '').toLowerCase().trim() === email &&
    e.calendly_event_start != null &&
    Math.abs(new Date(e.calendly_event_start).getTime() - t) <= 15 * 60_000);
}
