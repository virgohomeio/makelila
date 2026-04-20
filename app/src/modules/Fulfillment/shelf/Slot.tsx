import type { ShelfSlot } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

type DragHandlers = {
  onDragStart: (e: React.DragEvent, slot: ShelfSlot) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
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

  const draggable = slot.status !== 'empty';

  return (
    <div
      className={cls}
      draggable={draggable}
      onDragStart={e => handlers.onDragStart(e, slot)}
      onDragEnd={handlers.onDragEnd}
      onDragOver={handlers.onDragOver}
      onDragLeave={handlers.onDragLeave}
      onDrop={e => handlers.onDrop(e, slot)}
      title={slot.serial ? `${slot.serial} (${slot.skid} · ${slot.slot_index})` : `empty ${slot.skid} · ${slot.slot_index}`}
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
