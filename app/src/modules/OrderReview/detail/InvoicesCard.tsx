import type { Order } from '../../../lib/orders';
import { useInvoicesByOrder, getInvoiceSignedUrl } from '../../../lib/invoices';
import { formatMoney } from '../../../lib/money';
import styles from '../OrderReview.module.css';

// Sales invoices / refund receipts attached to this order. Auto-matched by the
// Upload module from the "Shopify order# NNNN" line in the invoice PDF, or
// assigned manually from the Upload review queue.
export function InvoicesCard({ order }: { order: Order }) {
  const { invoices, loading } = useInvoicesByOrder(order.id);

  const view = async (path: string) => {
    try {
      const url = await getInvoiceSignedUrl(path);
      window.open(url, '_blank', 'noopener');
    } catch (e) { alert((e as Error).message); }
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Invoices</div>
      <div className={styles.cardBody}>
        {loading ? (
          <div style={{ fontSize: 12, color: 'var(--color-ink-muted)' }}>Loading…</div>
        ) : invoices.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--color-ink-muted)' }}>
            No invoices attached. Bulk-upload them in the Upload tab — they auto-attach by order number.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {invoices.map(inv => (
              <div key={inv.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, flexWrap: 'wrap' }}>
                <strong>#{inv.invoice_number}</strong>
                <span style={{ color: 'var(--color-ink-muted)' }}>
                  {inv.document_type === 'refund_receipt' ? 'Refund receipt' : 'Invoice'}
                </span>
                <span style={{ color: 'var(--color-ink-muted)' }}>
                  {inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString('en-US') : '—'}
                </span>
                <span style={{ marginLeft: 'auto' }}>
                  {inv.total_cad != null ? formatMoney(inv.total_cad, 'CAD') : ''}
                </span>
                <button
                  onClick={() => void view(inv.storage_path)}
                  style={{ background: 'none', border: 'none', color: 'var(--color-crimson)', cursor: 'pointer', textDecoration: 'underline', fontSize: 12, padding: 0 }}
                >View PDF</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
