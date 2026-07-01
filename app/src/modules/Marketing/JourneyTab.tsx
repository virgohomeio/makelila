import { useMemo, useState } from 'react';
import { useCustomers } from '../../lib/customers';
import { useOrders } from '../../lib/orders';
import { useCustomerEvents } from '../../lib/customerEvents';
import {
  buildJourney, useCustomerTouch, useAcquisitionOverview,
} from '../../lib/marketing/journey';

const subtle = 'var(--color-ink-subtle)';
const muted = 'var(--color-ink-muted)';

export function JourneyTab() {
  const { customers } = useCustomers();
  const { rows: acq, loading: acqLoading } = useAcquisitionOverview();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return customers
      .filter(c =>
        c.full_name?.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q))
      .slice(0, 30);
  }, [customers, search]);

  const selected = useMemo(
    () => customers.find(c => c.id === selectedId) ?? null,
    [customers, selectedId],
  );

  const acqTotal = acq.reduce((s, r) => s + r.count, 0);

  return (
    <div>
      {/* Acquisition overview — where buyers come from (first touch) */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Acquisition by channel (first touch)</div>
        {acqLoading ? (
          <p style={{ color: subtle, fontSize: 13 }}>Loading…</p>
        ) : acq.length === 0 ? (
          <p style={{ color: subtle, fontSize: 13 }}>No attribution captured yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {acq.map(r => (
              <div key={r.channel} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                <span style={{ width: 130, color: muted }}>{r.channel}</span>
                <div style={{ flex: 1, background: 'var(--color-surface)', borderRadius: 4, overflow: 'hidden', height: 16 }}>
                  <div style={{
                    width: `${acqTotal ? (r.count / acqTotal) * 100 : 0}%`,
                    background: 'var(--color-crimson)', height: '100%',
                  }} />
                </div>
                <span style={{ width: 64, textAlign: 'right' }}>
                  {r.count} <span style={{ color: subtle }}>({acqTotal ? Math.round((r.count / acqTotal) * 100) : 0}%)</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-customer journey lookup */}
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Customer buying journey</div>
      <input
        type="search"
        value={search}
        onChange={e => { setSearch(e.target.value); setSelectedId(null); }}
        placeholder="Search a customer by name or email…"
        style={{
          width: '100%', maxWidth: 420, padding: '7px 10px', fontSize: 13,
          border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm, 6px)', marginBottom: 8,
        }}
      />

      {search && !selected && (
        <div style={{ maxWidth: 420, border: '1px solid var(--color-border)', borderRadius: 6, marginBottom: 16, maxHeight: 240, overflowY: 'auto' }}>
          {matches.length === 0 ? (
            <div style={{ padding: 10, fontSize: 12, color: subtle }}>No matches.</div>
          ) : matches.map(c => (
            <button
              key={c.id}
              onClick={() => { setSelectedId(c.id); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px',
                background: 'none', border: 'none', borderBottom: '1px solid var(--color-border)',
                cursor: 'pointer', fontSize: 12,
              }}
            >
              <strong>{c.full_name || '—'}</strong>{' '}
              <span style={{ color: subtle }}>{c.email ?? ''}</span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <JourneyDetail
          customerId={selected.id}
          name={selected.full_name || selected.email || 'Customer'}
          email={selected.email ?? null}
          onClear={() => { setSelectedId(null); setSearch(''); }}
        />
      )}
    </div>
  );
}

function JourneyDetail({
  customerId, name, email, onClear,
}: {
  customerId: string;
  name: string;
  email: string | null;
  onClear: () => void;
}) {
  const { touch, loading: touchLoading } = useCustomerTouch(customerId);
  const { events } = useCustomerEvents(customerId);
  const { all: orders } = useOrders();

  const myOrders = useMemo(() => {
    const lcEmail = email?.toLowerCase() ?? '';
    return orders.filter(o =>
      o.customer_id === customerId ||
      (lcEmail && o.customer_email?.toLowerCase() === lcEmail));
  }, [orders, customerId, email]);

  const journey = useMemo(
    () => buildJourney(touch, myOrders, events),
    [touch, myOrders, events],
  );

  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: 16, marginTop: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>{name}</div>
        <button onClick={onClear} style={{ background: 'none', border: 'none', color: 'var(--color-crimson)', cursor: 'pointer', fontSize: 12 }}>
          ← back to search
        </button>
      </div>

      {/* Summary tiles */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        <Tile label="Came from (first touch)" value={journey.firstChannel} sub={journey.firstCampaign ?? undefined} />
        <Tile label="Last touch before order" value={journey.lastChannel ?? '—'} sub={journey.lastCampaign ?? undefined} />
        <Tile label="Days first touch → purchase" value={journey.daysFirstTouchToOrder != null ? `${journey.daysFirstTouchToOrder}d` : '—'} />
        <Tile label="Orders" value={String(journey.orderCount)} />
        <Tile label="Lifetime spend" value={journey.totalSpend ? fmt(journey.totalSpend, journey.currency) : '—'} />
        <Tile label="Email profile" value={journey.hasEmailProfile ? 'Klaviyo ✓' : 'none'} />
      </div>

      {/* Phase-2 honesty note */}
      <div style={{ fontSize: 11, color: muted, background: 'var(--color-surface)', borderRadius: 6, padding: '8px 10px', marginBottom: 14 }}>
        Showing attribution touch + app engagement + orders. Visit-by-visit web path (sessions before buying, exact first/last page)
        arrives in Phase 2 with the Shopify Customer-Journey + Klaviyo email-event sync — those touches drop straight into this timeline.
      </div>

      {/* Timeline */}
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Timeline</div>
      {touchLoading ? (
        <p style={{ color: subtle, fontSize: 13 }}>Loading…</p>
      ) : journey.touches.length === 0 ? (
        <p style={{ color: subtle, fontSize: 13 }}>No touches recorded for this customer yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {journey.touches.map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0', borderTop: i === 0 ? 'none' : '1px solid var(--color-border)' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: t.color, marginTop: 4, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12 }}>{t.label}</div>
                {t.sub && <div style={{ fontSize: 11, color: subtle }}>{t.sub}</div>}
              </div>
              <span style={{ fontSize: 11, color: subtle, whiteSpace: 'nowrap' }}>
                {t.at ? new Date(t.at).toLocaleDateString('en-CA', { year: '2-digit', month: 'short', day: 'numeric' }) : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '8px 12px', minWidth: 130 }}>
      <div style={{ fontSize: 10, color: subtle, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: muted, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function fmt(n: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(n);
  } catch {
    return `$${n.toFixed(0)}`;
  }
}
