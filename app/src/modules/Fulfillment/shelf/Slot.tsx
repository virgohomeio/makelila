import type { ShelfSlot } from '../../../lib/fulfillment';
import { getStatusMeta } from '../../../lib/stock';
import styles from '../Fulfillment.module.css';

// Why each slot colour shows — keyed by shelf_slots.status.
const SHELF_STATUS_REASON: Record<string, string> = {
  available: 'Available — ready to assign (green)',
  reserved:  'Reserved for an order (orange)',
  rework:    'Failed QC — pending rework (red)',
  held:      'Held — out of circulation (amber)',
  empty:     'Empty',
};

function slotTooltip(slot: ShelfSlot): string {
  if (!slot.serial) return `Empty · Skid ${slot.skid} · slot ${slot.slot_index}`;
  return [
    slot.serial,
    `Shelf: ${SHELF_STATUS_REASON[slot.status] ?? slot.status}`,
    slot.unit_status ? `Machine: ${getStatusMeta(slot.unit_status).label}` : null,
    `Skid ${slot.skid} · slot ${slot.slot_index}`,
  ].filter(Boolean).join('\n');
}

type DragHandlers = {
  onDragStart: (e: React.DragEvent, slot: ShelfSlot) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent, slot: ShelfSlot) => void;
  onDragLeave: (e: React.DragEvent, slot: ShelfSlot) => void;
  onDrop: (e: React.DragEvent, slot: ShelfSlot) => void;
};

export function Slot({
  slot,
  shape,
  isDragging,
  isDropTarget,
  handlers,
}: {
  slot: ShelfSlot;
  shape: 'portrait' | 'landscape';
  isDragging: boolean;
  isDropTarget: boolean;
  handlers: DragHandlers;
}) {
  const cls = [
    styles.slot,
    shape === 'portrait' ? styles.portrait : styles.landscape,
    styles[slot.status],
    isDragging ? styles.dragging : '',
    isDropTarget ? styles.dropTarget : '',
  ].filter(Boolean).join(' ');

  // 'held' units (team-test / quarantine) are physically present but out of
  // circulation — don't let an operator drag one onto an order.
  const draggable = slot.status !== 'empty' && slot.status !== 'held';

  return (
    <div
      className={cls}
      draggable={draggable}
      onDragStart={e => handlers.onDragStart(e, slot)}
      onDragEnd={handlers.onDragEnd}
      onDragOver={e => handlers.onDragOver(e, slot)}
      onDragLeave={e => handlers.onDragLeave(e, slot)}
      onDrop={e => handlers.onDrop(e, slot)}
      title={slotTooltip(slot)}
    >
      {slot.serial ? (
        <>
          <div className={styles.slotSerial}>…{slot.serial.slice(-5)}</div>
          <div className={styles.slotBatch}>{slot.batch}</div>
        </>
      ) : <div className={styles.slotBatch}>empty</div>}
    </div>
  );
}
