# Feature 2: PaymentCard UI on OrderReview

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the Shopify financial breakdown (subtotal, discount, tax, shipping, total, payment methods, financial status) in a read-only card on the OrderReview detail panel, so operators don't need to open Shopify to see payment details.

**Architecture:** New `PaymentCard.tsx` + `PaymentCard.module.css` mirroring the `AddressCard` pattern (card header + key-value grid, no mutations). Wired into `Detail.tsx` between `LineItemsCard` and `NotesCard`. All Shopify financial fields already exist on the `Order` type — no schema changes needed.

**Tech Stack:** React 18 + TypeScript, CSS Modules, Vitest snapshots

---

## File Map

| File | Change |
|------|--------|
| `app/src/modules/OrderReview/detail/PaymentCard.tsx` | Create |
| `app/src/modules/OrderReview/detail/PaymentCard.module.css` | Create |
| `app/src/modules/OrderReview/Detail.tsx` | Modify — wire PaymentCard after LineItemsCard |

No `lib/` changes. No migrations. No edge function changes.

---

### Task 1: PaymentCard snapshot tests

**Files:**
- Create: `app/src/modules/OrderReview/detail/__tests__/PaymentCard.test.tsx`

- [ ] **Step 1: Create the test file with three fixtures**

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PaymentCard } from '../PaymentCard';
import type { Order } from '../../../../lib/orders';

// Minimal order fixture — only the fields PaymentCard reads.
function makeOrder(overrides: Partial<Order>): Order {
  return {
    id: 'ord-1',
    order_ref: '#1001',
    kind: 'sale',
    status: 'pending',
    customer_id: null,
    linked_ticket_id: null,
    awaiting_batch_id: null,
    replacement_state: null,
    cogs_usd: null,
    shipping_cost_usd: null,
    shipped_at: null,
    delivered_at: null,
    tracking_num: null,
    carrier: null,
    customer_name: 'Ron Russell',
    customer_email: 'ron@example.com',
    customer_phone: null,
    quo_thread_url: null,
    address_line: '123 Main St',
    address_line2: null,
    city: 'Ottawa',
    region_state: 'ON',
    country: 'CA',
    address_verdict: 'house',
    address_verified_at: null,
    address_match: null,
    address_google_formatted: null,
    address_google_postal: null,
    address_customer_postal: 'K1A 0A9',
    address_claude_verdict: null,
    address_claude_notes: null,
    address_claude_postal: null,
    freight_estimate_usd: 0,
    freight_threshold_usd: 100,
    customer_paid_shipping_usd: null,
    freight_estimate_source: 'shopify',
    currency: 'CAD',
    total_usd: 1396,
    subtotal_usd: null,
    tax_usd: null,
    discount_total_usd: null,
    discount_codes: null,
    payment_methods: null,
    financial_status: null,
    line_items: [],
    sales_confirmed_fit: false,
    dispositioned_by: null,
    dispositioned_at: null,
    created_at: '2026-01-01T00:00:00Z',
    placed_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Order;
}

describe('PaymentCard', () => {
  it('renders full Shopify Payments breakdown', () => {
    const order = makeOrder({
      currency: 'CAD',
      total_usd: 1396,
      subtotal_usd: 1299,
      tax_usd: 97,
      discount_total_usd: 0,
      customer_paid_shipping_usd: 0,
      payment_methods: ['shopify_payments'],
      financial_status: 'paid',
    });
    const { container } = render(<PaymentCard order={order} />);
    expect(container).toMatchSnapshot();
    expect(container.textContent).toContain('1,396');
    expect(container.textContent).toContain('paid');
  });

  it('renders Sezzle partial payment with discount', () => {
    const order = makeOrder({
      currency: 'USD',
      total_usd: 1100,
      subtotal_usd: 1299,
      tax_usd: 0,
      discount_total_usd: 199,
      discount_codes: ['SAVE200'],
      payment_methods: ['sezzle'],
      financial_status: 'partially_paid',
    });
    const { container } = render(<PaymentCard order={order} />);
    expect(container).toMatchSnapshot();
    expect(container.textContent).toContain('−');
    expect(container.textContent).toContain('SAVE200');
    expect(container.textContent).toContain('Partially paid');
  });

  it('renders refunded status and hides zero-discount row', () => {
    const order = makeOrder({
      currency: 'CAD',
      total_usd: 0,
      subtotal_usd: 1299,
      tax_usd: 0,
      discount_total_usd: null,
      payment_methods: ['shopify_payments'],
      financial_status: 'refunded',
    });
    const { container } = render(<PaymentCard order={order} />);
    expect(container).toMatchSnapshot();
    expect(container.textContent).toContain('Refunded');
    // discount row should not appear when null/zero
    expect(container.textContent).not.toContain('Discount');
  });

  it('renders without blowing up when all optional fields are null', () => {
    const order = makeOrder({
      subtotal_usd: null,
      tax_usd: null,
      discount_total_usd: null,
      payment_methods: null,
      financial_status: null,
    });
    expect(() => render(<PaymentCard order={order} />)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run — expect failure (PaymentCard doesn't exist yet)**

```bash
cd app
npm test -- PaymentCard
```
Expected: FAIL "Cannot find module '../PaymentCard'".

---

### Task 2: Implement PaymentCard

**Files:**
- Create: `app/src/modules/OrderReview/detail/PaymentCard.tsx`
- Create: `app/src/modules/OrderReview/detail/PaymentCard.module.css`

- [ ] **Step 1: Create the CSS module**

```css
/* PaymentCard.module.css — mirrors AddressCard layout */
.card {
  /* inherits from OrderReview.module.css .card via classname pass-through */
}

.statusBadge {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 4px;
}

.paid       { background: #f0fff4; color: #276749; border: 1px solid #9ae6b4; }
.partially_paid { background: #fffaf0; color: #c05621; border: 1px solid #fbd38d; }
.pending    { background: #f7fafc; color: #4a5568; border: 1px solid #cbd5e0; }
.refunded   { background: #ebf8ff; color: #2c5282; border: 1px solid #90cdf4; }
.voided     { background: #f7fafc; color: #718096; border: 1px solid #cbd5e0; }

.methodChip {
  display: inline-block;
  font-size: 10px;
  padding: 2px 8px;
  background: var(--color-surface, #f7fafc);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 4px);
  color: var(--color-ink-muted, #718096);
  font-family: var(--font-mono, monospace);
}
```

- [ ] **Step 2: Create `PaymentCard.tsx`**

```tsx
import type { Order } from '../../../lib/orders';
import { formatMoney } from '../../../lib/money';
import styles from './PaymentCard.module.css';
import cardStyles from '../OrderReview.module.css';

const STATUS_LABEL: Record<string, string> = {
  paid:             'Paid',
  partially_paid:   'Partially paid',
  pending:          'Pending',
  refunded:         'Refunded',
  voided:           'Voided',
};

const STATUS_CLASS: Record<string, string> = {
  paid:           styles.paid,
  partially_paid: styles.partially_paid,
  pending:        styles.pending,
  refunded:       styles.refunded,
  voided:         styles.voided,
};

export function PaymentCard({ order }: { order: Order }) {
  const fmt = (n: number | null | undefined) => formatMoney(n, order.currency);

  const hasBreakdown =
    order.subtotal_usd != null ||
    order.tax_usd != null ||
    order.discount_total_usd != null;

  const showDiscount = hasBreakdown && (order.discount_total_usd ?? 0) > 0;
  const showTax = hasBreakdown && (order.tax_usd ?? 0) > 0;
  const shipping = order.customer_paid_shipping_usd ?? 0;
  const showShipping = hasBreakdown && shipping > 0;

  const codes = order.discount_codes?.filter(Boolean) ?? [];
  const methods = order.payment_methods?.filter(Boolean) ?? [];
  const status = order.financial_status;
  const statusLabel = status ? (STATUS_LABEL[status] ?? status.replace(/_/g, ' ')) : null;
  const statusClass = status ? (STATUS_CLASS[status] ?? '') : '';

  return (
    <div className={cardStyles.card}>
      <div className={cardStyles.cardHead}>Payment Summary</div>
      <div className={cardStyles.cardBody}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>
            {fmt(order.total_usd)}
          </span>
          <span style={{ fontSize: 11, color: 'var(--color-ink-subtle)' }}>
            {order.currency}
          </span>
        </div>

        {hasBreakdown && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 12, marginBottom: 12 }}>
            {order.subtotal_usd != null && (
              <>
                <span style={{ color: 'var(--color-ink-subtle)' }}>Subtotal</span>
                <span style={{ textAlign: 'right' }}>{fmt(order.subtotal_usd)}</span>
              </>
            )}
            {showDiscount && (
              <>
                <span style={{ color: 'var(--color-ink-subtle)' }}>
                  Discount{codes.length > 0 && <> <span style={{ fontSize: 10 }}>({codes.join(', ')})</span></>}
                </span>
                <span style={{ textAlign: 'right', color: 'var(--color-success, #2a8c4a)' }}>
                  −{fmt(order.discount_total_usd)}
                </span>
              </>
            )}
            {showTax && (
              <>
                <span style={{ color: 'var(--color-ink-subtle)' }}>Tax</span>
                <span style={{ textAlign: 'right' }}>{fmt(order.tax_usd)}</span>
              </>
            )}
            {showShipping && (
              <>
                <span style={{ color: 'var(--color-ink-subtle)' }}>Shipping paid</span>
                <span style={{ textAlign: 'right' }}>{fmt(shipping)}</span>
              </>
            )}
          </div>
        )}

        {(methods.length > 0 || statusLabel) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
            {methods.map(m => (
              <span key={m} className={styles.methodChip}>{m.replace(/_/g, ' ')}</span>
            ))}
            {statusLabel && (
              <span className={`${styles.statusBadge} ${statusClass}`}>{statusLabel}</span>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run tests — expect pass**

```bash
npm test -- PaymentCard
```
Expected: 4 tests pass, snapshots created.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/OrderReview/detail/PaymentCard.tsx \
        app/src/modules/OrderReview/detail/PaymentCard.module.css \
        app/src/modules/OrderReview/detail/__tests__/PaymentCard.test.tsx
git commit -m "feat(OrderReview): add PaymentCard showing Shopify financial breakdown"
```

---

### Task 3: Wire PaymentCard into Detail.tsx

**Files:**
- Modify: `app/src/modules/OrderReview/Detail.tsx`

- [ ] **Step 1: Add import**

At the top of `Detail.tsx`, after the existing detail imports:

```tsx
import { PaymentCard }  from './detail/PaymentCard';
```

- [ ] **Step 2: Insert card between LineItemsCard and NotesCard**

Find this section in the JSX (around line 91-93):

```tsx
{order.kind === 'sale' && <FreightCard order={order} />}
<LineItemsCard order={order} />
<NotesCard order={order} />
```

Change to:

```tsx
{order.kind === 'sale' && <FreightCard order={order} />}
<LineItemsCard order={order} />
{order.kind === 'sale' && <PaymentCard order={order} />}
<NotesCard order={order} />
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev
```
Open OrderReview, click any `kind='sale'` order → confirm PaymentCard renders below Line Items with total, payment method chips, and status badge. Verify no edit fields appear (read-only).

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/OrderReview/Detail.tsx
git commit -m "feat(OrderReview): wire PaymentCard into order detail panel"
```
