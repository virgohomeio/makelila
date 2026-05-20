import { useState } from 'react';
import {
  type FactoryOrder, type FreightShipment, type POStatus, type FreightStatus,
  PO_STATUS_META, FREIGHT_STATUS_META,
  updatePOStatus, updateFreightStatus, createFreight,
} from '../../../lib/build';
import styles from '../Build.module.css';

type Props = {
  order: FactoryOrder;
  freight: FreightShipment | null;
  unitsLanded: number;
  onClose: () => void;
};

const PO_STATES: POStatus[] = ['placed','in_production','ready_to_ship','shipped','cancelled'];
const FREIGHT_STATES: FreightStatus[] = ['booked','on_boat','in_customs','in_transit','arrived'];

export function BatchDetail({ order, freight, unitsLanded, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const poMeta = PO_STATUS_META[order.status];
  const fMeta = freight ? FREIGHT_STATUS_META[freight.status] : null;

  async function run<T>(p: Promise<T>) {
    setBusy(true); setError(null);
    try { await p; }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className={styles.detailOverlay}>
      <div className={styles.detailHead}>
        <div>
          <h3 className={styles.detailTitle}>{order.batch}</h3>
          <div className={styles.detailSub}>{order.po_number} · {order.manufacturer}</div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>✕</button>
      </div>
      <div className={styles.detailBody}>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Purchase Order</div>
          <div className={styles.detailFieldGrid}>
            <span className={styles.detailFieldLabel}>Qty ordered</span>
            <span className={styles.detailFieldValue}>{order.qty_ordered}</span>
            <span className={styles.detailFieldLabel}>Units landed</span>
            <span className={styles.detailFieldValue}>{unitsLanded}</span>
            <span className={styles.detailFieldLabel}>Unit cost</span>
            <span className={styles.detailFieldValue}>
              {order.unit_cost_usd ? `$${order.unit_cost_usd.toFixed(2)} USD` : '—'}
            </span>
            <span className={styles.detailFieldLabel}>Target ship</span>
            <span className={styles.detailFieldValue}>
              {order.ship_target_date ? new Date(order.ship_target_date).toLocaleDateString() : '—'}
            </span>
            <span className={styles.detailFieldLabel}>Placed</span>
            <span className={styles.detailFieldValue}>{new Date(order.placed_at).toLocaleDateString()}</span>
            <span className={styles.detailFieldLabel}>Status</span>
            <span>
              <span className={styles.pill} style={{ background: poMeta.bg, color: poMeta.color }}>
                {poMeta.label}
              </span>
            </span>
          </div>
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Advance PO status</div>
          <div className={styles.actionsRow}>
            {PO_STATES.filter(s => s !== order.status).map(s => (
              <button
                key={s}
                className={styles.btnSecondary}
                disabled={busy}
                onClick={() => run(updatePOStatus(order.id, s))}
              >→ {PO_STATUS_META[s].label}</button>
            ))}
          </div>
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Freight</div>
          {freight ? (
            <>
              <div className={styles.detailFieldGrid}>
                <span className={styles.detailFieldLabel}>Carrier</span>
                <span className={styles.detailFieldValue}>{freight.carrier ?? '—'}</span>
                <span className={styles.detailFieldLabel}>Container</span>
                <span className={`${styles.detailFieldValue} ${styles.cardMono}`}>{freight.container_no ?? '—'}</span>
                <span className={styles.detailFieldLabel}>ETD China</span>
                <span className={styles.detailFieldValue}>
                  {freight.etd_china ? new Date(freight.etd_china).toLocaleDateString() : '—'}
                </span>
                <span className={styles.detailFieldLabel}>ETA Canada</span>
                <span className={styles.detailFieldValue}>
                  {freight.eta_canada ? new Date(freight.eta_canada).toLocaleDateString() : '—'}
                </span>
                <span className={styles.detailFieldLabel}>Customs cleared</span>
                <span className={styles.detailFieldValue}>
                  {freight.customs_cleared_at ? new Date(freight.customs_cleared_at).toLocaleDateString() : '—'}
                </span>
                <span className={styles.detailFieldLabel}>Arrived</span>
                <span className={styles.detailFieldValue}>
                  {freight.arrived_at_warehouse_at ? new Date(freight.arrived_at_warehouse_at).toLocaleDateString() : '—'}
                </span>
                <span className={styles.detailFieldLabel}>Status</span>
                <span>
                  {fMeta && (
                    <span className={styles.pill} style={{ background: fMeta.bg, color: fMeta.color }}>
                      {fMeta.label}
                    </span>
                  )}
                </span>
              </div>
              <div className={styles.actionsRow}>
                {FREIGHT_STATES.filter(s => s !== freight.status).map(s => (
                  <button
                    key={s}
                    className={styles.btnSecondary}
                    disabled={busy}
                    onClick={() => run(updateFreightStatus(freight.id, s))}
                  >→ {FREIGHT_STATUS_META[s].label}</button>
                ))}
              </div>
            </>
          ) : (
            <div className={styles.actionsRow}>
              <button
                className={styles.btnPrimary}
                disabled={busy}
                onClick={() => run(createFreight({ po_id: order.id }))}
              >+ Add freight shipment</button>
            </div>
          )}
        </div>

        {error && <div style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</div>}

        {order.notes && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>Notes</div>
            <div style={{ fontSize: 12, color: 'var(--color-ink)', whiteSpace: 'pre-wrap' }}>{order.notes}</div>
          </div>
        )}

      </div>
    </div>
  );
}
