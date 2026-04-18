import type { Order } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

export function LineItemsCard({ order }: { order: Order }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Line Items</div>
      <div className={styles.cardBody}>
        <table className={styles.liTable}>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Item</th>
              <th>Qty</th>
              <th style={{ textAlign: 'right' }}>Price</th>
            </tr>
          </thead>
          <tbody>
            {order.line_items.map((li, i) => (
              <tr key={`${li.sku}-${i}`}>
                <td>{li.sku}</td>
                <td>{li.name}</td>
                <td>{li.qty}</td>
                <td style={{ textAlign: 'right' }}>${(li.qty * li.price_usd).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Total</td>
              <td style={{ textAlign: 'right' }}>${order.total_usd.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
