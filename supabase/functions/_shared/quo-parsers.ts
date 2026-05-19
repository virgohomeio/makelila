// Pure parsers for Quo-forwarded SMS subjects, RFC-5322 From headers, and
// phone numbers. Used by the Gmail sync edge function.
//
// MIRROR LOCATION: app/src/lib/quo-parsers.ts (kept byte-identical;
// app/scripts/check-classifier-drift.mjs enforces).
//
// Zero imports — pure TS — so Deno (edge function) and Node (Vitest) consume
// the same file. Mirror exists because Supabase edge function deploys only
// see files under supabase/functions/, and Vitest can't easily reach that
// tree without custom path config.

// ============================================================ Quo subject parsing
//
// Quo forwards SMS and missed-call notifications with subjects like:
//   "New text message from RJ Down (813) 492-5113"
//   "Missed call from RJ Down (813) 492-5113"
//   "New text message from (813) 492-5113"
//   "Missed call from (813) 492-5113"

const QUO_RE = /^(New text message|Missed call) from(?:\s+(.+?))?\s+(\(\d{3}\)\s*\d{3}[-\s]?\d{4})\s*$/i;

export type QuoSubject = {
  kind: 'sms' | 'missed_call' | null;
  name: string | null;
  phone: string | null;
};

export function parseQuoSubject(subject: string): QuoSubject {
  const m = subject?.match(QUO_RE);
  if (!m) return { kind: null, name: null, phone: null };
  const kind = m[1].toLowerCase().startsWith('new') ? 'sms' : 'missed_call';
  return {
    kind,
    name: (m[2]?.trim()) || null,
    phone: m[3],
  };
}

// ============================================================ RFC 5322 From parsing
//
//   "Name <email@host>"   → { name: "Name",     email: "email@host" }
//   "\"Name\" <email@host>" → quotes stripped
//   "email@host"          → { name: null,       email: "email@host" }

const FROM_RE = /^\s*(?:"?([^"<]+?)"?\s*)?<?([^>\s]+@[^>\s]+)>?\s*$/;

export type ParsedFrom = { name: string | null; email: string | null };

export function parseFromHeader(from: string): ParsedFrom {
  if (!from) return { name: null, email: null };
  const m = from.match(FROM_RE);
  if (!m) return { name: null, email: null };
  return { name: m[1]?.trim() || null, email: m[2]?.toLowerCase() || null };
}

// ============================================================ Phone normalization
//
// E.164 for US/CA numbers only. We're a US/CA shop; international numbers
// pass through unchanged so we don't break them. Drop libphonenumber-js
// unless we expand abroad.

export function normalizePhone(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return raw;
}
