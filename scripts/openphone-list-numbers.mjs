#!/usr/bin/env node
// One-off helper: list OpenPhone phone numbers with their IDs so you can
// pick the "Lila Pro Service" line's PN_xxxxx ID for the
// OPENPHONE_PHONE_NUMBER_IDS Supabase secret.
//
// Usage (PowerShell):
//   $env:OPENPHONE_API_KEY = '<your rotated key>'
//   node scripts/openphone-list-numbers.mjs
//
// Or pass auth styles to test which OpenPhone wants:
//   node scripts/openphone-list-numbers.mjs --bearer
//
// Treats the key as a password; never echoes it.

const key = process.env.OPENPHONE_API_KEY;
if (!key) {
  console.error('Missing OPENPHONE_API_KEY env var.');
  process.exit(1);
}

const useBearer = process.argv.includes('--bearer');
const auth = useBearer ? `Bearer ${key}` : key;
console.log(`Auth style: ${useBearer ? 'Bearer <key>' : '<key> (raw)'}`);
console.log(`Key length: ${key.length}  (expected: 64 chars for standard OpenPhone keys)\n`);

const res = await fetch('https://api.openphone.com/v1/phone-numbers', {
  headers: { Authorization: auth },
});

const text = await res.text();
console.log(`HTTP ${res.status}\n`);

try {
  const json = JSON.parse(text);
  const lines = Array.isArray(json.data) ? json.data : [];
  if (lines.length === 0) {
    console.log('Response body:');
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log(`Found ${lines.length} phone number(s):\n`);
    for (const line of lines) {
      console.log(`  id:    ${line.id}`);
      console.log(`  name:  ${line.name ?? '(no name)'}`);
      console.log(`  phone: ${line.formattedNumber ?? line.number ?? '(no number)'}`);
      console.log('');
    }
  }
} catch {
  console.log('Body (not JSON):');
  console.log(text);
}
