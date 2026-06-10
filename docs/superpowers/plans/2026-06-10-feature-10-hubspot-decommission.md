# Feature 10: HubSpot Decommission — makelila as System of Record

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop relying on HubSpot for any operational data that makelila now owns. This means: (1) auditing which data types are still flowing from HubSpot into makelila and which go the other way, (2) making the HubSpot sync read-only/import-only for the remaining data types (leads, contacts), and (3) adding a health indicator to the Marketing module showing which data types are being sourced from where.

**Architecture:** No new tables or edge functions. The work is entirely in `docs/system-of-record.md` (update ownership table), `lib/customers.ts` (enforce insert-only on HubSpot sync), and a new `SystemOfRecordCard.tsx` in the Marketing module. The decommission is operational, not technical — no HubSpot credentials are removed. This plan just ensures makelila never overwrites operator-curated data with stale HubSpot values.

**Dependency:** Feature 3 (lead attribution columns) should ship first so the `hs_analytics_source` mapping is in place before we lock down the sync direction.

**Tech Stack:** React 18 + TypeScript, Supabase Postgres, CSS Modules

---

## File Map

| File | Change |
|------|--------|
| `docs/system-of-record.md` | Modify — update HubSpot rows to reflect makelila ownership |
| `app/src/lib/customers.ts` | Modify — enforce insert-only semantics on HubSpot sync |
| `app/src/lib/customers.test.ts` | Modify — add test for insert-only guard |
| `app/src/modules/Marketing/SystemOfRecordCard.tsx` | Create |
| `app/src/modules/Marketing/index.tsx` | Modify — add SystemOfRecordCard to Sync tab |

---

### Task 1: Audit and update `docs/system-of-record.md`

**Files:**
- Modify: `docs/system-of-record.md`

- [ ] **Step 1: Read the current file**

```bash
cat docs/system-of-record.md
```

Note each data type and its current source-of-truth designation.

- [ ] **Step 2: Update HubSpot rows**

For each data type row where HubSpot is currently marked as source-of-truth or bidirectional, update to one of:
- **makelila (owner)** — if makelila now owns this data
- **HubSpot → makelila (import-only)** — if HubSpot is still the input source for initial data
- **HubSpot (deprecated sync)** — if the sync should be turned off

Apply these rules:
- Customer `name`, `email`, `phone`: `HubSpot → makelila (import-only)` — we import on first contact, never overwrite if operator has edited
- Customer `stage`, `notes`, `address`: `makelila (owner)` — operators set these, HubSpot never touches them
- Lead source / attribution: `HubSpot → makelila (import-only)` — populate `hs_analytics_source` on first sync, never overwrite
- Deal stage: `makelila (owner)` — order status in makelila is truth, not HubSpot deal stage
- Activity log: `makelila (owner)` — we log our own actions, HubSpot is not consulted

- [ ] **Step 3: Commit**

```bash
git add docs/system-of-record.md
git commit -m "docs: update system-of-record to reflect makelila ownership post-HubSpot decommission"
```

---

### Task 2: Enforce insert-only on HubSpot sync in `lib/customers.ts`

**Files:**
- Modify: `app/src/lib/customers.ts`
- Modify: `app/src/lib/customers.test.ts`

- [ ] **Step 1: Read `lib/customers.ts`**

```bash
cat app/src/lib/customers.ts
```

Find the function that syncs HubSpot contacts into the `customers` table. Look for `upsert` calls that could overwrite operator-curated fields (`name`, `phone`, `stage`, `notes`).

- [ ] **Step 2: Write the guard test first**

Add to `app/src/lib/customers.test.ts`:

```ts
describe('upsertHubSpotContact — insert-only guard', () => {
  it('does not overwrite name/phone/stage if the customer already exists', async () => {
    // Mock: existing customer with operator-curated name
    const existingCustomer = {
      id: 'cust-1',
      email: 'ron@example.com',
      name: 'Ron (Operator Corrected)',
      phone: '+16135551234',
      stage: 'customer',
      klaviyo_profile_id: null,
      first_touch_source: null,
    };
    selectMock.mockResolvedValueOnce({ data: [existingCustomer], error: null });

    await upsertHubSpotContact({
      email: 'ron@example.com',
      name: 'Ron Russell',        // HubSpot has stale name
      phone: '+16135559999',      // HubSpot has stale phone
      hs_analytics_source: 'ORGANIC_SEARCH',
    });

    // The upsert call should NOT include name or phone
    const upsertArg = upsertMock.mock.calls[0]?.[0];
    expect(upsertArg).not.toHaveProperty('name');
    expect(upsertArg).not.toHaveProperty('phone');
    // But it SHOULD include hs_analytics_source (attribution, always safe)
    expect(upsertArg).toHaveProperty('hs_analytics_source', 'ORGANIC_SEARCH');
  });
});
```

Note: You'll need to add `upsertHubSpotContact` to the mock imports if it doesn't exist yet.

- [ ] **Step 3: Run — expect failure**

```bash
npm test -- customers
```
Expected: FAIL (either `upsertHubSpotContact` doesn't exist, or it overwrites fields).

- [ ] **Step 4: Implement or fix `upsertHubSpotContact` in `lib/customers.ts`**

Find the existing HubSpot sync upsert. Replace with insert-only logic:

```ts
export async function upsertHubSpotContact(hubspotContact: {
  email: string;
  name?: string | null;
  phone?: string | null;
  hs_analytics_source?: string | null;
}): Promise<void> {
  // Check if customer already exists
  const { data: existing } = await supabase
    .from('customers')
    .select('id, name, phone')
    .eq('email', hubspotContact.email)
    .maybeSingle();

  const safeFields: Record<string, unknown> = {
    email: hubspotContact.email,
    // Attribution fields are always safe to update (they're additive, not overwriting)
    ...(hubspotContact.hs_analytics_source != null
      ? { first_touch_source: hubspotContact.hs_analytics_source }
      : {}),
  };

  if (!existing) {
    // New customer — safe to set all fields from HubSpot
    if (hubspotContact.name) safeFields['name'] = hubspotContact.name;
    if (hubspotContact.phone) safeFields['phone'] = hubspotContact.phone;
  }
  // If existing: do NOT set name/phone — operator may have corrected them

  const { error } = await supabase
    .from('customers')
    .upsert(safeFields, { onConflict: 'email', ignoreDuplicates: false });

  if (error) throw new Error(error.message);

  await logAction(
    'hubspot_contact_synced',
    hubspotContact.email,
    existing ? 'updated (attribution only)' : 'inserted (new customer)',
  );
}
```

- [ ] **Step 5: Run tests — expect pass**

```bash
npm test -- customers
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/customers.ts app/src/lib/customers.test.ts
git commit -m "feat(lib): enforce insert-only semantics on HubSpot contact sync"
```

---

### Task 3: `SystemOfRecordCard.tsx` — data ownership display

**Files:**
- Create: `app/src/modules/Marketing/SystemOfRecordCard.tsx`
- Modify: `app/src/modules/Marketing/index.tsx`

- [ ] **Step 1: Create `SystemOfRecordCard.tsx`**

A static display card — no data fetching, just a reference table for operators.

```tsx
// SystemOfRecordCard.tsx
const DATA_OWNERSHIP = [
  { entity: 'Customer name / email / phone', owner: 'makelila', source: 'HubSpot (insert only)' },
  { entity: 'Customer stage', owner: 'makelila', source: 'Operators' },
  { entity: 'Lead attribution source', owner: 'makelila', source: 'HubSpot / Shopify UTM' },
  { entity: 'Orders', owner: 'makelila', source: 'Shopify' },
  { entity: 'Fulfillment status', owner: 'makelila', source: 'Operators' },
  { entity: 'Returns / Refunds', owner: 'makelila', source: 'Operators / Customer forms' },
  { entity: 'Deal stage', owner: 'makelila', source: 'Orders (not HubSpot deals)' },
  { entity: 'Email campaigns', owner: 'Klaviyo', source: 'makelila profiles sync' },
  { entity: 'Ad performance', owner: 'Facebook', source: 'CAPI + Ads API sync' },
  { entity: 'Activity log', owner: 'makelila', source: 'All mutations' },
];

export function SystemOfRecordCard() {
  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-ink-muted)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 12 }}>
        System of Record
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: 'var(--color-ink-subtle)', fontSize: 11 }}>
            <th style={{ textAlign: 'left', paddingBottom: 8 }}>Data Type</th>
            <th style={{ textAlign: 'left' }}>Owner</th>
            <th style={{ textAlign: 'left' }}>Source</th>
          </tr>
        </thead>
        <tbody>
          {DATA_OWNERSHIP.map((row, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--color-border)' }}>
              <td style={{ padding: '7px 0', color: 'var(--color-ink)' }}>{row.entity}</td>
              <td>
                <span style={{
                  fontSize: 10, padding: '2px 8px', borderRadius: 4, fontWeight: 700,
                  background: row.owner === 'makelila' ? '#ebf8ff' : 'var(--color-surface)',
                  color: row.owner === 'makelila' ? '#2c5282' : 'var(--color-ink-muted)',
                  border: `1px solid ${row.owner === 'makelila' ? '#90cdf4' : 'var(--color-border)'}`,
                }}>
                  {row.owner}
                </span>
              </td>
              <td style={{ color: 'var(--color-ink-subtle)', paddingLeft: 8 }}>{row.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Add `SystemOfRecordCard` to the Sync tab in Marketing `index.tsx`**

In `modules/Marketing/index.tsx`, find the `{tab === 'sync' && ...}` block. Add the import and card at the bottom of the sync tab:

```tsx
import { SystemOfRecordCard } from './SystemOfRecordCard';

// Inside tab === 'sync' block, after the Klaviyo sync log table:
<SystemOfRecordCard />
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Marketing/SystemOfRecordCard.tsx \
        app/src/modules/Marketing/index.tsx
git commit -m "feat(Marketing): add SystemOfRecordCard showing data ownership per entity type"
```
