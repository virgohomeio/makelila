# Feature 6: CAC by Channel Dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Pedrum the cost to acquire each customer broken down by marketing channel — combining Facebook ad spend (Feature 7) with lead attribution data (Feature 3) and order conversion data to compute CAC per channel (e.g., "Meta Ads: $380/customer, Organic: $0/customer").

**Architecture:** New `lib/marketing/cac.ts` exports `useCacByChannel` which joins `fb_campaigns` (spend) with `customers` (attribution source) and `orders` (conversions). New `CacDashboard.tsx` component in `modules/Marketing/` renders a simple bar chart and data table. No new DB tables — all computation is in-memory from existing tables. Depends on Features 3 (lead attribution columns) and 7 (fb_campaigns table).

**Dependency:** Features 3 and 7 must be shipped first.

**Tech Stack:** React 18 + TypeScript, CSS Modules, Vitest, no external charting library (use CSS bars)

---

## File Map

| File | Change |
|------|--------|
| `app/src/lib/marketing/cac.ts` | Create |
| `app/src/lib/marketing/cac.test.ts` | Create |
| `app/src/modules/Marketing/CacDashboard.tsx` | Create |
| `app/src/modules/Marketing/CacDashboard.module.css` | Create |

---

### Task 1: `lib/marketing/cac.ts` — CAC computation

**Files:**
- Create: `app/src/lib/marketing/cac.ts`
- Create: `app/src/lib/marketing/cac.test.ts`

The CAC computation:
- **Spend per channel:** Sum `fb_campaigns.spend_cad` grouped by a derived channel name (Facebook = all fb_campaigns rows, Organic = $0 spend). For future channels, extend the grouping.
- **Customers acquired per channel:** Count `customers` rows where `first_touch_source` matches the channel (Feature 3 adds `first_touch_source`), filtered to customers who have at least one paid order.
- **CAC = total_spend / customers_acquired**. If customers_acquired = 0, CAC = null (avoid division by zero).

- [ ] **Step 1: Write tests first**

Create `app/src/lib/marketing/cac.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeCac } from './cac';
import type { CacInput } from './cac';

const input: CacInput = {
  fbSpendByMonth: [
    { month: '2026-05', spend_cad: 1200 },
    { month: '2026-04', spend_cad: 900 },
  ],
  customersByChannel: [
    { channel: 'facebook', count: 5 },
    { channel: 'organic', count: 3 },
    { channel: 'referral', count: 2 },
  ],
};

describe('computeCac', () => {
  it('computes CAC for Facebook from spend / acquired customers', () => {
    const result = computeCac(input);
    const fb = result.find(r => r.channel === 'facebook');
    // total spend = 2100, customers = 5, CAC = 420
    expect(fb?.cac_cad).toBeCloseTo(420, 1);
    expect(fb?.spend_cad).toBe(2100);
    expect(fb?.customers_acquired).toBe(5);
  });

  it('returns cac_cad = null for organic (no spend)', () => {
    const result = computeCac(input);
    const organic = result.find(r => r.channel === 'organic');
    expect(organic?.cac_cad).toBeNull();
    expect(organic?.spend_cad).toBe(0);
  });

  it('returns cac_cad = null when customers_acquired = 0', () => {
    const noCustomers: CacInput = {
      fbSpendByMonth: [{ month: '2026-05', spend_cad: 500 }],
      customersByChannel: [],
    };
    const result = computeCac(noCustomers);
    const fb = result.find(r => r.channel === 'facebook');
    expect(fb?.cac_cad).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd app
npm test -- marketing/cac
```
Expected: FAIL "Cannot find module './cac'".

- [ ] **Step 3: Create `lib/marketing/cac.ts`**

```ts
import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

export type CacInput = {
  fbSpendByMonth: Array<{ month: string; spend_cad: number }>;
  customersByChannel: Array<{ channel: string; count: number }>;
};

export type CacRow = {
  channel: string;
  spend_cad: number;
  customers_acquired: number;
  cac_cad: number | null;
};

export function computeCac(input: CacInput): CacRow[] {
  const totalFbSpend = input.fbSpendByMonth.reduce((s, r) => s + r.spend_cad, 0);
  const channelMap = new Map<string, number>(
    input.customersByChannel.map(c => [c.channel, c.count]),
  );

  const channels = Array.from(
    new Set([
      'facebook',
      ...input.customersByChannel.map(c => c.channel),
    ]),
  );

  return channels.map(ch => {
    const spend = ch === 'facebook' ? totalFbSpend : 0;
    const acquired = channelMap.get(ch) ?? 0;
    const cac = spend > 0 && acquired > 0 ? +(spend / acquired).toFixed(2) : null;
    return { channel: ch, spend_cad: spend, customers_acquired: acquired, cac_cad: cac };
  });
}

type CacState = { rows: CacRow[]; loading: boolean };

export function useCacByChannel(): CacState {
  const [state, setState] = useState<CacState>({ rows: [], loading: true });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [spendRes, channelRes] = await Promise.all([
        supabase
          .from('fb_campaigns')
          .select('date_start, spend_cad')
          .not('spend_cad', 'is', null),
        supabase
          .from('customers')
          .select('first_touch_source')
          .not('first_touch_source', 'is', null),
      ]);

      if (cancelled) return;

      // Aggregate spend by month
      const spendByMonth = new Map<string, number>();
      for (const row of spendRes.data ?? []) {
        const month = (row.date_start as string).slice(0, 7);
        spendByMonth.set(month, (spendByMonth.get(month) ?? 0) + (row.spend_cad ?? 0));
      }

      // Count customers by channel
      const channelCount = new Map<string, number>();
      for (const row of channelRes.data ?? []) {
        const ch = (row.first_touch_source as string).toLowerCase();
        channelCount.set(ch, (channelCount.get(ch) ?? 0) + 1);
      }

      const rows = computeCac({
        fbSpendByMonth: Array.from(spendByMonth.entries()).map(([month, spend_cad]) => ({ month, spend_cad })),
        customersByChannel: Array.from(channelCount.entries()).map(([channel, count]) => ({ channel, count })),
      });

      setState({ rows, loading: false });
    })();
    return () => { cancelled = true; };
  }, []);

  return state;
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npm test -- marketing/cac
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/marketing/cac.ts app/src/lib/marketing/cac.test.ts
git commit -m "feat(lib): add marketing/cac.ts with computeCac and useCacByChannel"
```

---

### Task 2: `CacDashboard.tsx` component

**Files:**
- Create: `app/src/modules/Marketing/CacDashboard.tsx`
- Create: `app/src/modules/Marketing/CacDashboard.module.css`

- [ ] **Step 1: Create the CSS module**

```css
/* CacDashboard.module.css */
.container {
  padding: 20px 0;
}

.title {
  font-size: 13px;
  font-weight: 700;
  color: var(--color-ink-muted);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  margin-bottom: 16px;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.table th {
  text-align: left;
  padding: 6px 0;
  color: var(--color-ink-subtle);
  font-weight: 600;
  font-size: 11px;
  border-bottom: 1px solid var(--color-border);
}

.table td {
  padding: 8px 0;
  border-bottom: 1px solid var(--color-border-subtle, #f1f5f9);
  vertical-align: middle;
}

.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--color-crimson);
  display: inline-block;
  vertical-align: middle;
  margin-right: 8px;
  min-width: 2px;
}

.noData {
  color: var(--color-ink-subtle);
  font-size: 12px;
  padding: 20px 0;
}

.null {
  color: var(--color-ink-subtle);
  font-size: 11px;
}
```

- [ ] **Step 2: Create `CacDashboard.tsx`**

```tsx
import { useCacByChannel } from '../../lib/marketing/cac';
import styles from './CacDashboard.module.css';

export function CacDashboard() {
  const { rows, loading } = useCacByChannel();

  if (loading) return <div className={styles.noData}>Loading…</div>;
  if (rows.length === 0) return <div className={styles.noData}>No attribution data yet. Ship Features 3 and 7 first.</div>;

  // Find max CAC for bar scaling
  const maxCac = Math.max(...rows.map(r => r.cac_cad ?? 0), 1);

  return (
    <div className={styles.container}>
      <div className={styles.title}>Cost of Acquisition by Channel</div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th style={{ width: '25%' }}>Channel</th>
            <th style={{ width: '15%', textAlign: 'right' }}>Customers</th>
            <th style={{ width: '20%', textAlign: 'right' }}>Spend (CAD)</th>
            <th style={{ width: '40%', textAlign: 'right' }}>CAC</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.channel}>
              <td style={{ textTransform: 'capitalize', fontWeight: 600 }}>{row.channel}</td>
              <td style={{ textAlign: 'right' }}>{row.customers_acquired}</td>
              <td style={{ textAlign: 'right' }}>
                {row.spend_cad > 0
                  ? `$${row.spend_cad.toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                  : <span className={styles.null}>—</span>}
              </td>
              <td style={{ textAlign: 'right' }}>
                {row.cac_cad != null ? (
                  <>
                    <span
                      className={styles.bar}
                      style={{ width: `${(row.cac_cad / maxCac) * 80}px` }}
                    />
                    <strong>${row.cac_cad.toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</strong>
                  </>
                ) : (
                  <span className={styles.null}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Run full test suite**

```bash
cd app
npm test
```
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Marketing/CacDashboard.tsx \
        app/src/modules/Marketing/CacDashboard.module.css
git commit -m "feat(Marketing): add CacDashboard component showing spend and CAC per channel"
```
