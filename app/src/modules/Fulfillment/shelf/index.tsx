import { useMemo } from 'react';
import { useShelf, type ShelfSlot } from '../../../lib/fulfillment';
import { SkidCard } from './SkidCard';
import styles from '../Fulfillment.module.css';

function autoNextSerial(slots: ShelfSlot[]): string | null {
  const sorted = [...slots].sort((a, b) => {
    const aFront = a.slot_index >= 3 ? 0 : 1;
    const bFront = b.slot_index >= 3 ? 0 : 1;
    if (aFront !== bFront) return aFront - bFront;
    const an = parseInt(a.skid.replace(/^[A-Z]+/, ''), 10);
    const bn = parseInt(b.skid.replace(/^[A-Z]+/, ''), 10);
    if (an !== bn) return an - bn;
    return a.slot_index - b.slot_index;
  });
  return sorted.find(s => s.status === 'available' && s.serial)?.serial ?? null;
}

export default function Shelf() {
  const { slots, loading } = useShelf();

  const groupedBySkid = useMemo(() => {
    const m = new Map<string, ShelfSlot[]>();
    for (const s of slots) {
      if (!m.has(s.skid)) m.set(s.skid, []);
      m.get(s.skid)!.push(s);
    }
    return m;
  }, [slots]);

  const skidKeys = useMemo(() => Array.from({ length: 30 }, (_, i) => `A${i + 1}`), []);
  const stats = useMemo(() => {
    const out = { available: 0, reserved: 0, rework: 0, empty: 0 };
    for (const s of slots) out[s.status]++;
    return out;
  }, [slots]);
  const nextSerial = useMemo(() => autoNextSerial(slots), [slots]);

  if (loading) return <div>Loading shelf…</div>;

  return (
    <div className={styles.shelfLayout}>
      <div className={styles.shelfBar}>
        <div className={styles.shelfStats}>
          <strong>150 slots</strong> · {stats.available} available · {stats.reserved} reserved · {stats.rework} rework · {stats.empty} empty
        </div>
        <div className={styles.shelfStats}>
          Auto-assign next → <strong>{nextSerial ?? '—'}</strong>
        </div>
      </div>
      <div className={styles.skidGrid}>
        {skidKeys.map(skid => (
          <SkidCard
            key={skid}
            skid={skid}
            slots={groupedBySkid.get(skid) ?? []}
            dragSource={null}
            dragTarget={null}
            handlers={{
              onDragStart: () => {}, onDragEnd: () => {},
              onDragOver: () => {}, onDragLeave: () => {}, onDrop: () => {},
            }}
          />
        ))}
      </div>
    </div>
  );
}
