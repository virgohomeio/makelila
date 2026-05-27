# Returns & Refunds Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close 6 surgical gaps in the existing returns + refund-approval workflow per the spec at `docs/superpowers/specs/2026-05-27-returns-refunds-overhaul-design.md`.

**Architecture:** Single DB migration adds two enums + 4 columns. Lib gets new types + 1 mutation + guarded `financeApprove`. UI adds a category dropdown to ReturnsTab, a proper finance-review modal to RefundsTab, and a new DashboardTab (first tab in PostShipment). No new tables, no chart-library dep — inline SVG.

**Tech Stack:** React 18 + TypeScript + Supabase (Postgres + Realtime) + Vite. Existing patterns in `app/src/lib/postShipment.ts` and `app/src/modules/PostShipment/`.

---

### Task 1: Schema migration

**Files:**
- Create: `supabase/migrations/20260527120000_returns_refunds_overhaul.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 1. Return category enum + column
create type return_category as enum (
  'product_defect', 'software_issue', 'shipping_damage',
  'customer_service', 'financing', 'other'
);
alter table public.returns add column return_category return_category;

-- 2. Refund method enum + columns on refund_approvals
create type refund_method as enum (
  'shopify', 'sezzle', 'quickbooks_cc', 'bank_etransfer', 'original_card'
);
alter table public.refund_approvals
  add column refund_method refund_method,
  add column original_amount_usd numeric(10,2),
  add column amount_correction_note text;

-- 3. Backfill: capture as-submitted amount once
update public.refund_approvals
   set original_amount_usd = refund_amount_usd
 where original_amount_usd is null;
```

- [ ] **Step 2: Apply via MCP**

Use `mcp__claude_ai_Supabase__apply_migration` with name `returns_refunds_overhaul` and the SQL from step 1.

- [ ] **Step 3: Verify**

Run via MCP:
```sql
select count(*) as total,
       count(original_amount_usd) as backfilled
from public.refund_approvals;
```
Expected: `total = backfilled` (every existing approval got its original_amount captured).

```sql
select unnest(enum_range(NULL::return_category)) as return_category;
select unnest(enum_range(NULL::refund_method)) as refund_method;
```
Expected: 6 + 5 values respectively.

- [ ] **Step 4: Commit**

```powershell
git add supabase/migrations/20260527120000_returns_refunds_overhaul.sql
git commit -m @'
feat(returns): schema for return_category + refund_method + amount correction

Alpha P1 #2. Adds return_category enum (6 values) and refund_method
enum (5 values), plus original_amount_usd + amount_correction_note on
refund_approvals so Julie can adjust amount with required note.
Existing rows backfilled.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 2: Extend lib types + add updateReturnCategory mutation

**Files:**
- Modify: `app/src/lib/postShipment.ts`

- [ ] **Step 1: Add ReturnCategory type + META block**

Find the `ReturnStatus` block (~line 10) and add after the `RETURN_STATUS_ORDER` constant:

```typescript
export type ReturnCategory =
  | 'product_defect' | 'software_issue' | 'shipping_damage'
  | 'customer_service' | 'financing' | 'other';

export const RETURN_CATEGORY_META: Record<ReturnCategory, { label: string; color: string; bg: string }> = {
  product_defect:    { label: 'Product Defect',     color: '#9b2c2c', bg: '#fff5f5' },
  software_issue:    { label: 'Software Issue',     color: '#2b6cb0', bg: '#ebf8ff' },
  shipping_damage:   { label: 'Shipping Damage',    color: '#c05621', bg: '#fffaf0' },
  customer_service:  { label: 'Customer Service',   color: '#553c9a', bg: '#faf5ff' },
  financing:         { label: 'Financing',          color: '#276749', bg: '#f0fff4' },
  other:             { label: 'Other',              color: '#718096', bg: '#f7fafc' },
};

export const RETURN_CATEGORIES: ReturnCategory[] = [
  'product_defect','software_issue','shipping_damage',
  'customer_service','financing','other',
];
```

- [ ] **Step 2: Extend `ReturnRow` type**

Find the `ReturnRow` type definition (~line 33) and add `return_category` after `reason`:

```typescript
  reason: string | null;
  return_category: ReturnCategory | null;
```

- [ ] **Step 3: Add RefundMethod type + META**

Find the `REFUND_STATUS_META` block (~line 231) and add after it:

```typescript
export type RefundMethod =
  | 'shopify' | 'sezzle' | 'quickbooks_cc' | 'bank_etransfer' | 'original_card';

export const REFUND_METHOD_META: Record<RefundMethod, { label: string; description: string }> = {
  shopify:        { label: 'Shopify',              description: 'Process via Shopify Admin' },
  sezzle:         { label: 'Sezzle financing',     description: 'For Sezzle-financed orders' },
  quickbooks_cc:  { label: 'QuickBooks CC',        description: 'Card refund in QuickBooks' },
  bank_etransfer: { label: 'Bank e-transfer',      description: 'CA customers only' },
  original_card:  { label: 'Back to original card',description: 'Refund to the card used at checkout' },
};

export const REFUND_METHODS: RefundMethod[] = [
  'shopify','sezzle','quickbooks_cc','bank_etransfer','original_card',
];
```

- [ ] **Step 4: Extend `RefundApproval` type**

Find the `RefundApproval` type (~line 240) and add three fields after `refund_amount_usd`:

```typescript
  refund_method: RefundMethod | null;
  original_amount_usd: number | null;
  amount_correction_note: string | null;
```

- [ ] **Step 5: Add `updateReturnCategory` mutation**

Find `updateReturnStatus` (~line 110) and add this function below it:

```typescript
export async function updateReturnCategory(id: string, category: ReturnCategory | null): Promise<void> {
  const { error } = await supabase
    .from('returns')
    .update({ return_category: category })
    .eq('id', id);
  if (error) throw error;
  await logAction('return_category', id, category ?? 'cleared');
}
```

- [ ] **Step 6: Build to verify**

Run: `cd app && npm run build`
Expected: TypeScript compiles cleanly. (Existing test fixtures may need fields added — see Task 3.)

- [ ] **Step 7: Commit**

```powershell
git add app/src/lib/postShipment.ts
git commit -m @'
feat(returns): lib types for return_category + refund_method

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 3: Category dropdown in ReturnsTab + tests

**Files:**
- Modify: `app/src/modules/PostShipment/ReturnsTab.tsx`
- Modify (if needed): test fixtures referencing `ReturnRow`

- [ ] **Step 1: Find the return detail panel**

Read `ReturnsTab.tsx`. Look for the detail panel or modal where individual return fields are edited. Identify where the existing `reason` text/textarea lives. The category dropdown belongs immediately above the reason field.

- [ ] **Step 2: Add the category dropdown**

Add a `<select>` (or matching chip-group component if the rest of the file uses chips) that reads from `RETURN_CATEGORIES` / `RETURN_CATEGORY_META` and calls `updateReturnCategory(return.id, value)`. Include a blank "— Uncategorized —" option for nulls.

UI placement:
```
<label>Category</label>
<select value={r.return_category ?? ''} onChange={…}>
  <option value="">— Uncategorized —</option>
  {RETURN_CATEGORIES.map(c => <option key={c} value={c}>{RETURN_CATEGORY_META[c].label}</option>)}
</select>
<label>Reason / detail</label>
<textarea …existing… />
```

Also display the category badge in the return-row card (using `RETURN_CATEGORY_META[c].color` + `.bg`).

- [ ] **Step 3: Fix any test fixtures**

Run `cd app && npm test -- --run`. If existing `ReturnRow` fixtures are missing the new `return_category` field, add `return_category: null` to them.

- [ ] **Step 4: Build + tests pass**

Run `cd app && npm run build` and `cd app && npm test -- --run`. Both must be clean.

- [ ] **Step 5: Commit**

```powershell
git add app/src/modules/PostShipment/ReturnsTab.tsx app/src/modules/PostShipment/__tests__ 2>$null
git commit -m @'
feat(returns): category dropdown + badge in ReturnsTab

Operators tag each return with one of 6 categories. The free-text
reason field stays for detail. Enables Dashboard analytics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 4: financeApprove guard + extended signature

**Files:**
- Modify: `app/src/lib/postShipment.ts`

- [ ] **Step 1: Find current `financeApprove`**

Read the existing function. Note its signature: `financeApprove(id: string, note?: string): Promise<void>`.

- [ ] **Step 2: Replace with extended signature**

```typescript
export type FinanceApproveOpts = {
  method: RefundMethod;
  amount?: number;             // if omitted, keep original
  correction_note?: string;    // required if amount differs from original
  note?: string;               // free-form optional note (e.g. Stripe refund ID)
};

export async function financeApprove(id: string, opts: FinanceApproveOpts): Promise<void> {
  const userId = await currentUserId();

  // 1. Fetch the approval + linked return (if any) to validate
  const { data: approval, error: aErr } = await supabase
    .from('refund_approvals')
    .select('id, return_id, original_amount_usd, refund_amount_usd, status')
    .eq('id', id)
    .single();
  if (aErr || !approval) throw new Error(`Refund approval not found: ${aErr?.message}`);
  if (approval.status !== 'finance_review') {
    throw new Error(`Cannot finance-approve from status: ${approval.status}`);
  }

  // 2. Guard: if linked to a return, the return must be received/inspected/closed
  if (approval.return_id) {
    const { data: ret, error: rErr } = await supabase
      .from('returns')
      .select('id, status')
      .eq('id', approval.return_id)
      .single();
    if (rErr || !ret) throw new Error(`Linked return not found: ${rErr?.message}`);
    if (!['received','inspected','refunded','closed'].includes(ret.status)) {
      throw new Error(`Return is in status '${ret.status}' — refund cannot be processed until the unit is received.`);
    }
  }

  // 3. Compute amount + validate correction_note
  const original = Number(approval.original_amount_usd ?? approval.refund_amount_usd);
  const adjusted = opts.amount ?? original;
  const amountChanged = Number(adjusted.toFixed(2)) !== Number(original.toFixed(2));
  if (amountChanged && !opts.correction_note?.trim()) {
    throw new Error('Correction note is required when changing the refund amount.');
  }

  // 4. Update the approval row → status='refunded'
  const { error: upErr } = await supabase
    .from('refund_approvals')
    .update({
      status: 'refunded',
      refund_method: opts.method,
      refund_amount_usd: adjusted,
      amount_correction_note: amountChanged ? opts.correction_note!.trim() : null,
      finance_reviewed_by: userId,
      finance_reviewed_at: new Date().toISOString(),
      finance_note: opts.note?.trim() || null,
    })
    .eq('id', id);
  if (upErr) throw upErr;

  await logAction('refund_finance_approved', id, `${opts.method} $${adjusted.toFixed(2)}`);
}
```

- [ ] **Step 3: Check for any existing finance_reviewed_by/_at column names**

The existing function may use different column names. Read the original to confirm. If column names differ, match the existing convention rather than inventing new ones. (E.g., it may be `finance_approved_at`/`finance_approved_by` rather than `_reviewed_`.)

- [ ] **Step 4: Build to verify**

Run: `cd app && npm run build`. The old callers will fail TypeScript (signature changed) — that's expected. Task 5 will fix them.

- [ ] **Step 5: Commit**

```powershell
git add app/src/lib/postShipment.ts
git commit -m @'
feat(refunds): financeApprove guard + method/amount/note opts

Refuses approval when linked return is not yet received. Captures
refund_method and an editable amount with a required correction note
if the amount changes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 5: Finance review modal in RefundsTab

**Files:**
- Modify: `app/src/modules/PostShipment/RefundsTab.tsx`
- Modify: `app/src/modules/PostShipment/PostShipment.module.css` (for modal styles)

- [ ] **Step 1: Replace `window.prompt` finance-approve flow**

Find the `runApprove` function in `RefundCard` (~line 180). When `refund.status === 'finance_review'`, instead of `window.prompt`, open a new `<FinanceApproveModal>` component.

- [ ] **Step 2: Build the modal**

New component `FinanceApproveModal` inside `RefundsTab.tsx`:

```typescript
function FinanceApproveModal({
  refund, linkedReturn, onClose, onError,
}: {
  refund: RefundApproval;
  linkedReturn: ReturnRow | null;
  onClose: () => void;
  onError: (m: string | null) => void;
}) {
  const [method, setMethod] = useState<RefundMethod>('shopify');
  const original = Number(refund.original_amount_usd ?? refund.refund_amount_usd);
  const [amountStr, setAmountStr] = useState(original.toFixed(2));
  const [note, setNote] = useState('');
  const [correctionNote, setCorrectionNote] = useState('');
  const [busy, setBusy] = useState(false);

  const amount = Number(amountStr);
  const amountChanged = !Number.isNaN(amount) && Number(amount.toFixed(2)) !== Number(original.toFixed(2));

  // Shipping hint lookup: read orders.freight_estimate_usd via linked order_ref
  const [shipping, setShipping] = useState<{ total: number; freight: number } | null>(null);
  useEffect(() => {
    const ref = linkedReturn?.original_order_ref;
    if (!ref) { setShipping(null); return; }
    (async () => {
      const { data } = await supabase
        .from('orders')
        .select('total_usd, freight_estimate_usd')
        .eq('order_ref', ref)
        .maybeSingle();
      if (data) setShipping({ total: Number(data.total_usd), freight: Number(data.freight_estimate_usd) });
    })();
  }, [linkedReturn?.original_order_ref]);

  const run = async () => {
    if (amountChanged && !correctionNote.trim()) {
      onError('Correction note required when changing amount.');
      return;
    }
    setBusy(true); onError(null);
    try {
      await financeApprove(refund.id, {
        method,
        amount,
        correction_note: amountChanged ? correctionNote.trim() : undefined,
        note: note.trim() || undefined,
      });
      onClose();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
        <h3>Process refund</h3>
        <div className={styles.formGrid}>
          <label>Method</label>
          <select value={method} onChange={e => setMethod(e.target.value as RefundMethod)}>
            {REFUND_METHODS.map(m => (
              <option key={m} value={m}>{REFUND_METHOD_META[m].label}</option>
            ))}
          </select>

          <label>Amount (USD)</label>
          <div>
            <input
              type="number" step="0.01" min="0"
              value={amountStr}
              onChange={e => setAmountStr(e.target.value)}
            />
            <div className={styles.amountHint}>
              Original request: ${original.toFixed(2)}
              {shipping && (
                <> · Order total: ${shipping.total.toFixed(2)} · Shipping (non-refundable): ${shipping.freight.toFixed(2)} · Max refundable: ${(shipping.total - shipping.freight).toFixed(2)}</>
              )}
            </div>
          </div>

          {amountChanged && (
            <>
              <label>Correction note <span style={{color:'red'}}>*</span></label>
              <textarea
                value={correctionNote}
                onChange={e => setCorrectionNote(e.target.value)}
                placeholder="Why is the amount different from the original request?"
              />
            </>
          )}

          <label>Note (optional)</label>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Stripe refund ID, etc." />
        </div>
        <div className={styles.modalActions}>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button onClick={() => void run()} disabled={busy} className={styles.btnPrimary}>
            {busy ? 'Processing…' : `Refund $${amount.toFixed(2)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire modal into RefundsTab state**

Add `const [financeModalId, setFinanceModalId] = useState<string | null>(null);` to the parent component. When a card's finance-approve action is clicked, set this state. Render the modal at the bottom of `RefundsTab`.

- [ ] **Step 4: Add CSS for modal + form**

In `PostShipment.module.css`, add `.modalBackdrop`, `.modalCard`, `.formGrid`, `.amountHint`, `.modalActions` selectors (or reuse if patterns already exist — check first).

- [ ] **Step 5: Build + tests**

Run `cd app && npm run build` and `npm test -- --run`. Both must be clean.

- [ ] **Step 6: Commit**

```powershell
git add app/src/modules/PostShipment/RefundsTab.tsx app/src/modules/PostShipment/PostShipment.module.css
git commit -m @'
feat(refunds): finance review modal with method + editable amount + shipping hint

Replaces the window.prompt flow. Julie picks a refund method, can
adjust the amount (correction note required if changed), and sees the
order's shipping cost as a non-refundable cap hint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 6: New DashboardTab with 4 charts + KPI strip

**Files:**
- Create: `app/src/modules/PostShipment/DashboardTab.tsx`
- Modify: `app/src/modules/PostShipment/index.tsx` (add tab as first entry)
- Modify: `app/src/modules/PostShipment/PostShipment.module.css` (chart styles)

- [ ] **Step 1: Build the DashboardTab component**

The dashboard reads from existing hooks `useReturns()` and `useRefundApprovals()`. Compute aggregates client-side (no new queries needed).

```typescript
// Pseudocode for the data layer; full code in implementation
const { returns } = useReturns();
const { approvals } = useRefundApprovals();

// KPIs:
const totalYTD = returns.filter(r => new Date(r.created_at).getFullYear() === thisYear).length;
const refundedYTD = approvals.filter(a => a.status === 'refunded' && yr(a) === thisYear).reduce((s,a) => s + Number(a.refund_amount_usd), 0);
const avgDaysToRefund = avg(refundedApprovals.map(a => daysBetween(a.submitted_at, a.finance_reviewed_at)));
const denialRate = denied.length / (denied.length + refunded.length);

// Aggregates:
const byCategory = countBy(returns, r => r.return_category ?? 'other');
const byChannel  = countBy(returns, r => r.channel ?? 'Unknown');
const byCondition = countBy(returns, r => r.condition ?? 'Unknown');
const byMonth = group YTD returns by getMonth(created_at)
```

- [ ] **Step 2: Build inline SVG chart components**

Three reusable chart components in the same file:

```typescript
function BarChart({ data, color }: { data: Array<{ label: string; value: number }>; color: string }) {
  const max = Math.max(...data.map(d => d.value), 1);
  const w = 320, h = 180, pad = 28;
  const barW = (w - pad * 2) / data.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={styles.chartSvg}>
      {data.map((d, i) => {
        const barH = ((h - pad * 2) * d.value) / max;
        const x = pad + i * barW + 4;
        const y = h - pad - barH;
        return (
          <g key={d.label}>
            <rect x={x} y={y} width={barW - 8} height={barH} fill={color} />
            <text x={x + (barW - 8) / 2} y={y - 4} textAnchor="middle" fontSize="10">{d.value}</text>
            <text x={x + (barW - 8) / 2} y={h - 8} textAnchor="middle" fontSize="9" fill="#666">{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

function DonutChart({ data, colors }: { data: Array<{ label: string; value: number }>; colors: string[] }) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  let angle = -Math.PI / 2;
  const cx = 90, cy = 90, r = 70, rInner = 45;
  return (
    <svg viewBox="0 0 180 180" className={styles.chartSvg}>
      {data.map((d, i) => {
        const sweep = (d.value / total) * Math.PI * 2;
        const x0 = cx + r * Math.cos(angle), y0 = cy + r * Math.sin(angle);
        const x1 = cx + r * Math.cos(angle + sweep), y1 = cy + r * Math.sin(angle + sweep);
        const xi0 = cx + rInner * Math.cos(angle + sweep), yi0 = cy + rInner * Math.sin(angle + sweep);
        const xi1 = cx + rInner * Math.cos(angle), yi1 = cy + rInner * Math.sin(angle);
        const large = sweep > Math.PI ? 1 : 0;
        const d_attr = `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${xi0} ${yi0} A ${rInner} ${rInner} 0 ${large} 0 ${xi1} ${yi1} Z`;
        angle += sweep;
        return <path key={d.label} d={d_attr} fill={colors[i % colors.length]} />;
      })}
    </svg>
  );
}

function LineChart({ data, color }: { data: Array<{ label: string; value: number }>; color: string }) {
  const max = Math.max(...data.map(d => d.value), 1);
  const w = 360, h = 180, pad = 28;
  const stepX = (w - pad * 2) / Math.max(data.length - 1, 1);
  const points = data.map((d, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((h - pad * 2) * d.value) / max;
    return { x, y, label: d.label, value: d.value };
  });
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={styles.chartSvg}>
      <path d={path} fill="none" stroke={color} strokeWidth="2" />
      {points.map(p => <circle key={p.label} cx={p.x} cy={p.y} r="3" fill={color} />)}
      {points.map(p => <text key={`${p.label}-l`} x={p.x} y={h - 8} textAnchor="middle" fontSize="9" fill="#666">{p.label}</text>)}
    </svg>
  );
}
```

- [ ] **Step 3: Layout the dashboard**

```typescript
export function DashboardTab() {
  const { returns, loading: rLoading } = useReturns();
  const { approvals, loading: aLoading } = useRefundApprovals();
  if (rLoading || aLoading) return <div className={styles.loading}>Loading dashboard…</div>;

  const stats = useMemo(() => computeStats(returns, approvals), [returns, approvals]);
  return (
    <div className={styles.tabContent}>
      <div className={styles.kpiRow}>
        <KPI label="Total returns YTD" value={stats.totalYTD} />
        <KPI label="Refunded $ YTD" value={`$${stats.refundedYTD.toLocaleString()}`} />
        <KPI label="Avg days to refund" value={stats.avgDays != null ? `${stats.avgDays}d` : '—'} />
        <KPI label="Denial rate" value={`${(stats.denialRate * 100).toFixed(0)}%`} />
      </div>
      <div className={styles.dashGrid}>
        <ChartCard title="By Category"><BarChart data={stats.byCategory} color="#c05621" /></ChartCard>
        <ChartCard title="By Channel"><DonutChart data={stats.byChannel} colors={['#2b6cb0', '#9b2c2c']} /></ChartCard>
        <ChartCard title="By Condition"><BarChart data={stats.byCondition} color="#553c9a" /></ChartCard>
        <ChartCard title="Monthly Trend (YTD)"><LineChart data={stats.byMonth} color="#276749" /></ChartCard>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire as first tab in PostShipment/index.tsx**

In `index.tsx`:
```typescript
import { DashboardTab } from './DashboardTab';

type Tab = 'dashboard' | 'map' | 'history' | 'returns' | 'refunds' | 'cancellations' | 'replacements';

const TABS: { key: Tab; label: string }[] = [
  { key: 'dashboard',     label: 'Dashboard' },   // <-- new, first
  { key: 'map',           label: 'Delivery Map' },
  { key: 'history',       label: 'Fulfillment History' },
  { key: 'returns',       label: 'Returns' },
  { key: 'refunds',       label: 'Refunds' },
  { key: 'cancellations', label: 'Cancellations' },
  { key: 'replacements',  label: 'Replacements' },
];

export default function PostShipment() {
  const [tab, setTab] = useState<Tab>('dashboard');   // <-- default
  // …
  {tab === 'dashboard' && <DashboardTab />}
  // …
}
```

- [ ] **Step 5: Add CSS for dashboard grid + chart cards**

In `PostShipment.module.css`:
```css
.dashGrid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-top: 16px;
}
.chartCard {
  background: #fff;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 14px;
}
.chartCardHead {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--color-ink-subtle);
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}
.chartSvg { width: 100%; height: auto; }
```

- [ ] **Step 6: Build + tests**

Run `cd app && npm run build` and `npm test -- --run`. Both must be clean.

- [ ] **Step 7: Commit**

```powershell
git add app/src/modules/PostShipment/DashboardTab.tsx app/src/modules/PostShipment/index.tsx app/src/modules/PostShipment/PostShipment.module.css
git commit -m @'
feat(post-shipment): Dashboard tab with 4 charts + KPI strip

First tab in PostShipment. Aggregates returns by category, channel,
condition, and monthly trend. Inline SVG charts — no new dep.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 7: Final review

- [ ] **Step 1: Run full test suite + build**

```powershell
cd app
npm test -- --run
npm run build
```
Both must be clean.

- [ ] **Step 2: Smoke test in browser**

Run `npm run dev`. Open PostShipment:
- Dashboard renders, 4 KPIs populate, 4 charts render with real data
- ReturnsTab detail panel shows category dropdown + saves correctly
- RefundsTab: click finance-approve on a row in finance_review status → modal opens, method picker works, amount editable, shipping hint shows if order_ref exists
- Try to finance-approve a refund whose linked return.status='created' → error message

- [ ] **Step 3: No additional commit needed**

Task 7 is verification only. If issues are found, fix them and amend the most recent relevant commit (or a new fix commit).
