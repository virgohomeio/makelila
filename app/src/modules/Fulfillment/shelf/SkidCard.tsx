import type { ShelfSlot } from '../../../lib/fulfillment';
import { Slot } from './Slot';
import styles from '../Fulfillment.module.css';

type DragHandlers = React.ComponentProps<typeof Slot>['handlers'];

export function SkidCard({
  skid,
  slots,
  dragSource,
  dragTarget,
  handlers,
}: {
  skid: string;
  slots: ShelfSlot[];
  dragSource: { skid: string; slot_index: number } | null;
  dragTarget: { skid: string; slot_index: number } | null;
  handlers: DragHandlers;
}) {
  const byIndex = new Map(slots.map(s => [s.slot_index, s]));
  const get = (idx: number) => byIndex.get(idx) ?? {
    skid, slot_index: idx, serial: null, batch: null, status: 'empty' as const, updated_at: '',
  };
  const isDrag = (idx: number) => dragSource?.skid === skid && dragSource.slot_index === idx;
  const isTarget = (idx: number) => dragTarget?.skid === skid && dragTarget.slot_index === idx;

  return (
    <div className={styles.skidCard}>
      <div className={styles.skidLabel}>{skid}</div>
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
