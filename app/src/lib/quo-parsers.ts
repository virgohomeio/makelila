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
//   "Name <email@host>"     → { name: "Name",     email: "email@host" }
//   "\"Name\" <email@host>" → quotes stripped
//   "<email@host>"          → { name: null,       email: "email@host" }
//   "email@host"            → { name: null,       email: "email@host" }
//
// Named and bare are split into two regexes so the bare case can't be
// misparsed (a single optional-name group greedily ate the first char of
// bare emails, turning "quo@quo.com" into { name: "q", email: "uo@quo.com" }).

const NAMED_FROM_RE = /^\s*(?:"([^"]+)"|([^<]+?))\s*<([^>\s]+@[^>\s]+)>\s*$/;
const BARE_FROM_RE  = /^\s*<?([^>\s]+@[^>\s]+)>?\s*$/;

export type ParsedFrom = { name: string | null; email: string | null };

export function parseFromHeader(from: string): ParsedFrom {
  if (!from) return { name: null, email: null };
  const named = from.match(NAMED_FROM_RE);
  if (named) {
    const name = (named[1] ?? named[2] ?? '').trim();
    return { name: name || null, email: named[3].toLowerCase() };
  }
  const bare = from.match(BARE_FROM_RE);
  if (bare) return { name: null, email: bare[1].toLowerCase() };
  return { name: null, email: null };
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
