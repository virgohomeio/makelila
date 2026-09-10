import type { ShelfSlot, ShelfLocation } from '../../../lib/fulfillment';
import { Slot } from './Slot';
import styles from '../Fulfillment.module.css';

type DragHandlers = React.ComponentProps<typeof Slot>['handlers'];

/** A skid at VentureLab holds five machines in a 3-over-2 stack, and so does a
 *  pallet on the Flex Space manifest. The two shipments that arrived with no
 *  manifest are a single undifferentiated group of ninety — those render as a
 *  wrapping grid rather than being carved into pallets nobody counted. */
const STANDARD_SLOTS = 5;

export function SkidCard({
  skid,
  slots,
  location,
  note,
  dragSource,
  dragTarget,
  handlers,
}: {
  skid: string;
  slots: ShelfSlot[];
  location: ShelfLocation;
  note?: string;
  dragSource: { skid: string; slot_index: number } | null;
  dragTarget: { skid: string; slot_index: number } | null;
  handlers: DragHandlers;
}) {
  const byIndex = new Map(slots.map(s => [s.slot_index, s]));
  const get = (idx: number): ShelfSlot => byIndex.get(idx) ?? {
    skid, slot_index: idx, serial: null, batch: null,
    status: 'empty' as const, location, updated_at: '',
  };
  const isDrag = (idx: number) => dragSource?.skid === skid && dragSource.slot_index === idx;
  const isTarget = (idx: number) => dragTarget?.skid === skid && dragTarget.slot_index === idx;

  const maxIndex = slots.reduce((m, s) => Math.max(m, s.slot_index), -1);
  const isStandard = maxIndex < STANDARD_SLOTS;

  const header = (
    <div className={styles.skidLabel}>
      {skid}
      {note && <span className={styles.skidNote}> · {note}</span>}
    </div>
  );

  if (!isStandard) {
    const indexes = [...slots].sort((a, b) => a.slot_index - b.slot_index).map(s => s.slot_index);
    return (
      <div className={`${styles.skidCard} ${styles.skidCardWide}`}>
        {header}
        <div className={styles.bulkGrid}>
          {indexes.map(i => (
            <Slot key={i} slot={get(i)} shape="portrait"
                  isDragging={isDrag(i)} isDropTarget={isTarget(i)} handlers={handlers} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.skidCard}>
      {header}
      <div className={styles.skidRowTop}>
        {[0, 1, 2].map(i => (
          <Slot key={i} slot={get(i)} shape="portrait"
                isDragging={isDrag(i)} isDropTarget={isTarget(i)} handlers={handlers} />
        ))}
      </div>
      <div className={styles.skidRowBottom}>
        {[3, 4].map(i => (
          <Slot key={i} slot={get(i)} shape="landscape"
                isDragging={isDrag(i)} isDropTarget={isTarget(i)} handlers={handlers} />
        ))}
      </div>
    </div>
  );
}
