/** Blind-copy every customer-facing send to an internal archive address.
 *
 *  Resend leaves no trace in the support@lilacomposter.com Sent folder, and
 *  four of the functions that mail customers keep no audit row either, so
 *  there was no way to confirm from outside the app that a given email went
 *  out. A BCC puts a real copy in a real inbox.
 *
 *  BCC rather than CC deliberately: the customer never sees an internal
 *  address and cannot reply-all into it, while the copy is identical.
 *
 *  Pure on purpose — no Deno globals — so the app's test suite can cover it.
 *  Each caller reads EMAIL_ARCHIVE_BCC itself and passes it in, which means
 *  the address can be changed with an env var instead of a deploy. */

export const DEFAULT_ARCHIVE_BCC = 'reina@virgohome.io';

/** Addresses on this domain are colleagues, not customers. */
const INTERNAL_DOMAIN = 'virgohome.io';

function isInternal(address: string): boolean {
  return address.trim().toLowerCase().endsWith(`@${INTERNAL_DOMAIN}`);
}

/** The `bcc` value for a Resend payload, or undefined when no copy is wanted.
 *
 *  Skipped for a send whose recipients are all internal — operator digests and
 *  alerts are not customer mail, and archiving them would just be noise — and
 *  for one already addressed to the archive address, which would otherwise
 *  deliver twice. */
export function archiveBcc(
  to: string | string[] | null | undefined,
  archive: string | null | undefined = DEFAULT_ARCHIVE_BCC,
): string[] | undefined {
  const address = archive?.trim();
  if (!address) return undefined;

  const recipients = (Array.isArray(to) ? to : [to])
    .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
    .map(r => r.trim());
  if (recipients.length === 0) return undefined;

  const lowered = recipients.map(r => r.toLowerCase());
  if (lowered.includes(address.toLowerCase())) return undefined;
  if (recipients.every(isInternal)) return undefined;

  return [address];
}
