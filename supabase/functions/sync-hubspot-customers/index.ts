// Pull HubSpot CRM contacts and upsert into public.customers.
//
// Runs against HubSpot's Contacts API v3 with a private app access token.
// Paginates 100/page until exhausted (or hits a soft cap to avoid runaway
// pulls).
//
// Env: HUBSPOT_ACCESS_TOKEN (private app token, scope: crm.objects.contacts.read)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

type HubspotContact = {
  id: string;
  properties: {
    email?: string | null;
    firstname?: string | null;
    lastname?: string | null;
    phone?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    country?: string | null;
    [k: string]: string | null | undefined;
  };
};

const PROPERTIES = [
  'email', 'firstname', 'lastname', 'phone',
  'address', 'city', 'state', 'zip', 'country',
];
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // soft cap = 5,000 contacts per run

// Many HubSpot contacts have the full address concatenated into the
// `address` property with city/state/zip/country left blank. Parse those
// out as a fallback so the structured columns are usable for shipping +
// delivery-map features. Handles Canadian (A1A 1A1) and US (12345) formats,
// including spelled-out province names and trailing "United States".

const CA_PROV_NAME_TO_CODE: Record<string, string> = {
  'alberta': 'AB',
  'british columbia': 'BC',
  'manitoba': 'MB',
  'new brunswick': 'NB',
  'newfoundland': 'NL',
  'newfoundland and labrador': 'NL',
  'nova scotia': 'NS',
  'northwest territories': 'NT',
  'nunavut': 'NU',
  'ontario': 'ON',
  'prince edward island': 'PE',
  'quebec': 'QC',
  'québec': 'QC',
  'saskatchewan': 'SK',
  'yukon': 'YT',
};
const CA_CODES = new Set(['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT']);
const US_STATE_CODES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
  'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
  'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
]);

function findCaRegion(beforePostal: string): { region: string; before: string } | null {
  // Try 2-letter code at the trailing position
  const twoLetter = beforePostal.match(/\b([A-Za-z]{2})\s*$/);
  if (twoLetter && twoLetter.index !== undefined && CA_CODES.has(twoLetter[1].toUpperCase())) {
    return {
      region: twoLetter[1].toUpperCase(),
      before: beforePostal.slice(0, twoLetter.index).trim().replace(/,\s*$/, ''),
    };
  }
  // Try full province name at the trailing position
  const lower = beforePostal.toLowerCase();
  for (const [name, code] of Object.entries(CA_PROV_NAME_TO_CODE)) {
    if (name.length <= 2) continue;
    if (lower.endsWith(name)) {
      const cut = beforePostal.length - name.length;
      return {
        region: code,
        before: beforePostal.slice(0, cut).trim().replace(/,\s*$/, ''),
      };
    }
  }
  return null;
}

function parseAddress(addr: string | null | undefined): {
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
} {
  if (!addr) return { city: null, region: null, postal_code: null, country: null };

  // Strip common trailing country labels so the zip/postal regex anchors work
  const cleaned = addr
    .replace(/,?\s*(united states(?: of america)?|usa|u\.s\.a\.?|u\.s\.)\s*\.?\s*$/i, '')
    .replace(/,?\s*canada\s*\.?\s*$/i, '')
    .trim();

  // Canadian postal: A9A 9A9 (optional space). Strong signal.
  const caPostal = cleaned.match(/([A-Za-z]\d[A-Za-z])\s?(\d[A-Za-z]\d)/);
  if (caPostal && caPostal.index !== undefined) {
    const postal = `${caPostal[1].toUpperCase()} ${caPostal[2].toUpperCase()}`;
    const beforePostal = cleaned.slice(0, caPostal.index).trim().replace(/,\s*$/, '');
    const found = findCaRegion(beforePostal);
    if (found) {
      const parts = found.before.split(',').map(s => s.trim()).filter(Boolean);
      const city = parts.length > 0 ? parts[parts.length - 1] : null;
      return { city, region: found.region, postal_code: postal, country: 'Canada' };
    }
    return { city: null, region: null, postal_code: postal, country: 'Canada' };
  }

  // US ZIP: 5 digits, optionally + 4, at the trailing position (after country
  // labels are stripped above).
  const usZip = cleaned.match(/(?:^|[\s,])(\d{5}(?:-\d{4})?)\s*$/);
  if (usZip && usZip.index !== undefined) {
    const postal = usZip[1];
    const beforeZip = cleaned.slice(0, usZip.index + usZip[0].indexOf(postal)).trim().replace(/,\s*$/, '');
    const stateMatch = beforeZip.match(/\b([A-Za-z]{2})\s*$/);
    if (stateMatch && stateMatch.index !== undefined && US_STATE_CODES.has(stateMatch[1].toUpperCase())) {
      const region = stateMatch[1].toUpperCase();
      const beforeState = beforeZip.slice(0, stateMatch.index).trim().replace(/,\s*$/, '');
      const parts = beforeState.split(',').map(s => s.trim()).filter(Boolean);
      const city = parts.length > 0 ? parts[parts.length - 1] : null;
      return { city, region, postal_code: postal, country: 'US' };
    }
    return { city: null, region: null, postal_code: postal, country: 'US' };
  }

  return { city: null, region: null, postal_code: null, country: null };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try { return await handle(); }
  catch (err) {
    return new Response(
      JSON.stringify({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
});

async function handle(): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const hubspotToken = Deno.env.get('HUBSPOT_ACCESS_TOKEN');
  if (!supabaseUrl || !serviceKey || !hubspotToken) {
    return new Response(
      JSON.stringify({
        error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / HUBSPOT_ACCESS_TOKEN',
      }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let after: string | undefined = undefined;
  let pages = 0;
  let fetched = 0;
  let upserted = 0;
  const skipped: { id: string; reason: string }[] = [];
  const now = new Date().toISOString();

  while (pages < MAX_PAGES) {
    const url = new URL('https://api.hubapi.com/crm/v3/objects/contacts');
    url.searchParams.set('limit', String(PAGE_SIZE));
    for (const p of PROPERTIES) url.searchParams.append('properties', p);
    if (after) url.searchParams.set('after', after);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${hubspotToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      return new Response(
        JSON.stringify({ error: `HubSpot ${res.status}: ${body.slice(0, 400)}` }),
        { status: 502, headers: { ...corsHeaders, 'content-type': 'application/json' } },
      );
    }
    const json = await res.json() as {
      results: HubspotContact[];
      paging?: { next?: { after?: string } };
    };
    const results = json.results ?? [];
    fetched += results.length;
    pages++;

    for (const c of results) {
      const p = c.properties ?? {};
      if (!p.email && !p.firstname && !p.lastname) {
        skipped.push({ id: c.id, reason: 'no email / first / last' });
        continue;
      }
      // Fall back to parsing the concatenated address line when HubSpot's
      // structured city/state/zip/country fields are empty.
      const parsed = parseAddress(p.address);
      const row = {
        hubspot_id: c.id,
        email: p.email?.toLowerCase() ?? null,
        first_name: p.firstname ?? null,
        last_name: p.lastname ?? null,
        phone: p.phone ?? null,
        address_line: p.address ?? null,
        city: p.city ?? parsed.city,
        region: p.state ?? parsed.region,
        postal_code: p.zip ?? parsed.postal_code,
        country: p.country ?? parsed.country,
        last_synced_at: now,
      };
      const { error: upErr } = await admin.from('customers').upsert(row, {
        onConflict: 'hubspot_id',
      });
      if (upErr) {
        skipped.push({ id: c.id, reason: `db: ${upErr.message}` });
        continue;
      }
      upserted++;
    }

    after = json.paging?.next?.after;
    if (!after) break;
  }

  return new Response(
    JSON.stringify({ pages, fetched, upserted, skipped: skipped.length, skippedDetails: skipped.slice(0, 20) }),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
}
