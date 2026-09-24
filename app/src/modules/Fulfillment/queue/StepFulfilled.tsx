import { useState } from 'react';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import { useSentEmail } from '../../../lib/templates';

export function StepFulfilled({
  row,
  order,
}: {
  row: FulfillmentQueueRow;
  order: { customer_name: string; customer_email: string | null; order_ref: string; country: 'US'|'CA'; kind?: 'sale' | 'replacement' };
}) {
  const isReplacement = order.kind === 'replacement';
  const handoffRef = `${row.id.slice(0, 8)}-${Math.floor(Date.now() / 1000).toString(36)}`;
  const fulfilledOn = row.fulfilled_at
    ? new Date(row.fulfilled_at).toLocaleString('en-US')
    : '—';
  const serial = row.assigned_serial ?? '— not recorded —';
  const lilaShipment = [row.carrier, row.tracking_num].filter(Boolean).join(' · ') || '—';
  const starterKit = order.country === 'US'
    ? `Amazon · ${row.starter_tracking_num ?? '—'}`
    : 'Packed In';

  // Keep every row in the brand's Inter font (inherited). Use tabular-nums
  // so tracking numbers and serials align without switching font-family —
  // previously we mixed ui-monospace and Inter which looked inconsistent.
  const labelStyle = { color: 'var(--color-ink-subtle)' } as const;
  const valStyle = { fontVariantNumeric: 'tabular-nums' as const, color: 'var(--color-ink)' } as const;

  return (
    <div>
      <div style={{
        background: 'var(--color-success-bg)',
        border: '1.5px solid var(--color-success-border)',
        borderRadius: 6,
        padding: '10px 14px',
        marginBottom: 14,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <strong style={{ color: 'var(--color-success)', fontSize: 13, fontWeight: 700 }}>
          ✓ {isReplacement ? 'Replacement sent' : 'Fulfilled'} · {fulfilledOn}
        </strong>
        {/* A replacement shipped from the service ticket skips the queue's
            email step, so don't claim an email that was never sent. */}
        <span style={{ color: 'var(--color-success)', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
          {row.email_sent_at ? 'Email sent · ' : ''}Unit {serial}
        </span>
      </div>

      <div style={{
        border: '1px solid var(--color-border)', borderRadius: 6, padding: 14, fontSize: 12,
        display: 'grid', gridTemplateColumns: '140px 1fr', rowGap: 8, columnGap: 14,
        background: '#fff',
      }}>
        <span style={labelStyle}>Shipment</span>
        <span style={valStyle}>
          {isReplacement ? 'Replacement — warranty / service, no charge' : 'Sale'}
        </span>
        <span style={labelStyle}>Customer</span>
        <span style={valStyle}>{order.customer_name}</span>
        <span style={labelStyle}>Order ref</span>
        <span style={valStyle}>{order.order_ref}</span>
        <span style={labelStyle}>Email</span>
        <span style={valStyle}>{order.customer_email ?? '—'}</span>
        <span style={labelStyle}>Serial shipped</span>
        <span style={valStyle}>{serial}</span>
        <span style={labelStyle}>LILA shipment</span>
        <span style={valStyle}>{lilaShipment}</span>
        <span style={labelStyle}>Starter kit</span>
        <span style={valStyle}>{starterKit}</span>
      </div>

      {row.email_sent_at && (
        <SentEmailRecord orderRef={order.order_ref} sentAt={row.email_sent_at} />
      )}

      <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
        <button
          onClick={() => navigator.clipboard.writeText(handoffRef)}
          style={{
            background: '#fff', color: 'var(--color-ink-muted)',
            border: '1px solid var(--color-border)', padding: '6px 12px',
            borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer',
          }}
        >Copy handoff ref ({handoffRef})</button>
        {order.customer_email && (
          <a
            href={`mailto:${order.customer_email}`}
            style={{
              background: '#fff', color: 'var(--color-crimson)',
              border: '1px solid var(--color-border)', padding: '6px 12px',
              borderRadius: 4, fontSize: 11, fontWeight: 600, textDecoration: 'none',
            }}
          >Open customer email thread</a>
        )}
      </div>
    </div>
  );
}

/** Proof of what the customer was actually sent.
 *
 *  "Email sent" in the banner above is only the queue's own flag, and it says
 *  nothing about where the mail went or what it said — which is no help to an
 *  operator asking whether a send really happened. Resend leaves no copy in
 *  the support@ Sent folder either, so the audit row is the only record there
 *  is. This shows it, body included. */
function SentEmailRecord({ orderRef, sentAt }: { orderRef: string; sentAt: string }) {
  const { message, loading } = useSentEmail('shipment_confirmation', orderRef);
  const [open, setOpen] = useState(false);

  const box = {
    marginTop: 14, border: '1px solid var(--color-border)', borderRadius: 6,
    padding: 14, fontSize: 12, background: '#fff',
  } as const;

  if (loading) {
    return <div style={box}><span style={{ color: 'var(--color-ink-subtle)' }}>Looking up the sent email…</span></div>;
  }

  // Sends before 2026-09-24 were never written to email_messages. Say that,
  // rather than implying the email never went out.
  if (!message) {
    return (
      <div style={box}>
        <strong style={{ fontSize: 12 }}>Shipment email</strong>
        <div style={{ marginTop: 6, color: 'var(--color-ink-subtle)', lineHeight: 1.5 }}>
          The queue recorded this as sent on {new Date(sentAt).toLocaleString('en-US')}, but no copy
          was kept — sends before 24 Sep 2026 were not logged. Newer sends store the exact text here.
        </div>
      </div>
    );
  }

  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <strong style={{ fontSize: 12 }}>Shipment email</strong>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--color-crimson)', fontSize: 11, fontWeight: 600,
          }}
        >{open ? 'Hide the email' : 'Read the email that was sent'}</button>
      </div>

      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '140px 1fr', rowGap: 6, columnGap: 14 }}>
        <span style={{ color: 'var(--color-ink-subtle)' }}>Delivered to</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{message.recipient_email}</span>
        <span style={{ color: 'var(--color-ink-subtle)' }}>Sent</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {message.sent_at ? new Date(message.sent_at).toLocaleString('en-US') : '—'}
        </span>
        <span style={{ color: 'var(--color-ink-subtle)' }}>Status</span>
        <span>
          {message.status}
          {message.error && <span style={{ color: 'var(--color-error)' }}> — {message.error}</span>}
        </span>
        <span style={{ color: 'var(--color-ink-subtle)' }}>Resend id</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{message.resend_id ?? '—'}</span>
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--color-ink-subtle)', marginBottom: 4 }}>
            Subject: {message.subject}
          </div>
          <pre style={{
            background: 'var(--color-surface)', border: '1px solid var(--color-border)',
            padding: 10, borderRadius: 4, fontSize: 10, lineHeight: 1.5,
            whiteSpace: 'pre-wrap', maxHeight: 320, overflowY: 'auto', margin: 0,
            fontFamily: 'inherit',
          }}>{message.body}</pre>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 10, color: 'var(--color-ink-subtle)', lineHeight: 1.5 }}>
        Sent through Resend, so it will not appear in the support@lilacomposter.com Sent folder.
        This record is the proof of delivery.
      </div>
    </div>
  );
}
