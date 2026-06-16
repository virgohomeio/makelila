// Pull HubSpot CRM contacts and upsert into public.customers.
//
// Runs against HubSpot's Contacts API v3 with a private app access token.
// Paginates 100/page until exhausted (or hits a soft cap to avoid runaway
// pulls).
//
// Env: HUBSPOT_ACCESS_TOKEN (private app token, scope: crm.objects.contacts.read)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

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
    hs_analytics_source?: string | null;
    hs_analytics_source_data_1?: string | null;
    createdate?: string | null;
    [k: string]: string | null | undefined;
  };
};

const PROPERTIES = [
  'email', 'firstname', 'lastname', 'phone',
  'address', 'city', 'state', 'zip', 'country',
  'hs_analytics_source', 'hs_analytics_source_data_1', 'createdate',
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

// Normalize a HubSpot-style country string ("Canada", "United States", "USA",
// etc.) to an ISO-2 code so the customers.country column stays consistent
// (walkthrough #42). Returns the input unchanged for non-CA/US values so we
// don't silently drop "MX", "GB", etc. — those will surface in the data and
// can be mapped explicitly later.
function normalizeCountry(c: string | null | undefined): string | null {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  if (!s) return null;
  if (s === 'ca' || s === 'canada') return 'CA';
  if (s === 'us' || s === 'usa' || s === 'u.s.a.' || s === 'u.s.'
      || s === 'united states' || s === 'united states of america') return 'US';
  return c.trim(); // unknown — preserve as-is
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
      return { city, region: found.region, postal_code: postal, country: 'CA' };
    }
    return { city: null, region: null, postal_code: postal, country: 'CA' };
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

function mapHubspotSource(hsSource: string | null): string | null {
  if (!hsSource) return null;
  const MAP: Record<string, string> = {
    PAID_SOCIAL:      'facebook',
    ORGANIC_SEARCH:   'organic_search',
    EMAIL_MARKETING:  'email',
    DIRECT_TRAFFIC:   'direct',
    PAID_SEARCH:      'google_ads',
    REFERRALS:        'referral',
  };
  return MAP[hsSource] ?? hsSource.toLowerCase();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try { return await handle(req); }
  catch (err) {
    return new Response(
      JSON.stringify({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
});

async function handle(req: Request): Promise<Response> {
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

  let _caller;
  try { _caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  // Mixed-caller: accept both cron and user — no kind check.
  void _caller;

  // Prefetch the existing roster once so we can (a) detect new contacts and
  // (b) fill only BLANK columns on existing rows without an extra round-trip
  // per contact. Keyed by hubspot_id and by lowercased email so a HubSpot
  // contact still matches a row that was seeded from another source (e.g. an
  // order) and has a null hubspot_id.
  type ExistingRow = {
    id: string;
    hubspot_id: string | null;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    address_line: string | null;
    city: string | null;
    region: string | null;
    postal_code: string | null;
    country: string | null;
  };
  const { data: existingRows, error: loadErr } = await admin
    .from('customers')
    .select('id, hubspot_id, email, first_name, last_name, phone, address_line, city, region, postal_code, country');
  if (loadErr) {
    return new Response(
      JSON.stringify({ error: `load existing customers: ${loadErr.message}` }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
  const byHubspot = new Map<string, ExistingRow>();
  const byEmail = new Map<string, ExistingRow>();
  for (const r of (existingRows ?? []) as ExistingRow[]) {
    if (r.hubspot_id) byHubspot.set(r.hubspot_id, r);
    if (r.email) byEmail.set(r.email.toLowerCase(), r);
  }

  // Columns HubSpot may fill. Operator-owned columns (notes, fu_notes,
  // onboard_date, fu1/fu2_status, serials) are intentionally absent — HubSpot
  // never touches them.
  const FILLABLE = ['email', 'first_name', 'last_name', 'phone', 'address_line', 'city', 'region', 'postal_code', 'country'] as const;
  const isBlank = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

  let after: string | undefined = undefined;
  let pages = 0;
  let fetched = 0;
  let inserted = 0;   // brand-new customers added
  let filled = 0;     // existing rows that had >=1 blank column populated
  let touched = 0;    // existing rows whose last_synced_at was refreshed
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
      const email = p.email?.toLowerCase() ?? null;
      const candidate: Record<typeof FILLABLE[number], string | null> = {
        email,
        first_name: p.firstname ?? null,
        last_name: p.lastname ?? null,
        phone: p.phone ?? null,
        address_line: p.address ?? null,
        city: p.city ?? parsed.city,
        region: p.state ?? parsed.region,
        postal_code: p.zip ?? parsed.postal_code,
        country: normalizeCountry(p.country ?? parsed.country),
      };

      // Match an existing row by hubspot_id first, then by email (covers rows
      // seeded elsewhere that have no hubspot_id yet).
      const existing = byHubspot.get(c.id) ?? (email ? byEmail.get(email) : undefined);

      // makelila is the system of record (see docs/system-of-record.md). HubSpot
      // is an INPUT: we seed NEW customers from it and FILL BLANK fields on
      // existing rows, but never clobber a value an operator may have curated.
      if (!existing) {
        const { data: insRows, error: insErr } = await admin
          .from('customers')
          .insert({ hubspot_id: c.id, ...candidate, last_synced_at: now })
          .select('id, hubspot_id, email, first_name, last_name, phone, address_line, city, region, postal_code, country');
        if (insErr) {
          // Likely a race / unique collision — skip rather than clobber.
          skipped.push({ id: c.id, reason: `insert: ${insErr.message}` });
          continue;
        }
        inserted++;
        // Track within-run so a later duplicate contact fills instead of re-inserting.
        const row = (insRows?.[0] ?? null) as ExistingRow | null;
        if (row) {
          byHubspot.set(c.id, row);
          if (row.email) byEmail.set(row.email.toLowerCase(), row);
        }
        // Backfill first_touch attribution for newly-inserted customer.
        const hsSource = p.hs_analytics_source ?? null;
        const hsCampaign = p.hs_analytics_source_data_1 ?? null;
        const hsCreatedAt = p.createdate ?? null;
        if (hsSource && row?.id) {
          await admin
            .from('customers')
            .update({
              first_touch_source: mapHubspotSource(hsSource),
              first_touch_campaign_id: hsCampaign,
              first_touch_at: hsCreatedAt,
            })
            .eq('id', row.id)
            .is('first_touch_source', null);
        }
        continue;
      }

      // Existing row: fill only blank columns, adopt hubspot_id if missing,
      // always refresh last_synced_at so the UI reflects a live sync.
      // Also backfill first_touch attribution if not yet set.
      const hsSource = p.hs_analytics_source ?? null;
      const hsCampaign = p.hs_analytics_source_data_1 ?? null;
      const hsCreatedAt = p.createdate ?? null;
      if (hsSource) {
        await admin
          .from('customers')
          .update({
            first_touch_source: mapHubspotSource(hsSource),
            first_touch_campaign_id: hsCampaign,
            first_touch_at: hsCreatedAt,
          })
          .eq('id', existing.id)
          .is('first_touch_source', null);
      }
      const patch: Record<string, string | null> = { last_synced_at: now };
      let fillCount = 0;
      for (const col of FILLABLE) {
        if (isBlank(existing[col]) && !isBlank(candidate[col])) {
          patch[col] = candidate[col];
          // Reflect the fill in the in-memory row so a later duplicate contact
          // in the same run doesn't try to re-fill it.
          existing[col] = candidate[col];
          fillCount++;
        }
      }
      if (isBlank(existing.hubspot_id)) { patch.hubspot_id = c.id; existing.hubspot_id = c.id; }

      const { error: updErr } = await admin
        .from('customers')
        .update(patch)
        .eq('id', existing.id);
      if (updErr) {
        skipped.push({ id: c.id, reason: `update: ${updErr.message}` });
        continue;
      }
      touched++;
      if (fillCount > 0) filled++;
    }

    after = json.paging?.next?.after;
    if (!after) break;
  }

  return new Response(
    JSON.stringify({
      pages, fetched,
      inserted, filled, touched,
      // Back-compat: `upserted` historically meant "rows written". Keep it so
      // older callers don't break; it now sums new inserts + rows that changed.
      upserted: inserted + filled,
      skipped: skipped.length,
      skippedDetails: skipped.slice(0, 20),
    }),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
}
