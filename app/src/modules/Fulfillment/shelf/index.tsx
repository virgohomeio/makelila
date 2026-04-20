import { useMemo, useState } from 'react';
import { useShelf, swapSlots, confirmShelfLayout, type ShelfSlot } from '../../../lib/fulfillment';
import { SkidCard } from './SkidCard';
import { ReworksPanel } from './ReworksPanel';
import styles from '../Fulfillment.module.css';

type Pos = { skid: string; slot_index: number };

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
  const [source, setSource] = useState<Pos | null>(null);
  const [target, setTarget] = useState<Pos | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const handlers = {
    onDragStart: (e: React.DragEvent, slot: ShelfSlot) => {
      setSource({ skid: slot.skid, slot_index: slot.slot_index });
      e.dataTransfer.effectAllowed = 'move';
      // Firefox requires setData to initiate a drag; Chrome is lenient but setting
      // it is harmless. The payload is the source coordinates — we don't rely on
      // reading it back (we use React state), but it must be non-empty for Firefox.
      e.dataTransfer.setData('text/plain', `${slot.skid}:${slot.slot_index}`);
    },
    onDragEnd: () => { setSource(null); setTarget(null); },
    onDragOver: (e: React.DragEvent, slot: ShelfSlot) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setTarget({ skid: slot.skid, slot_index: slot.slot_index });
    },
    onDragLeave: (_e: React.DragEvent, slot: ShelfSlot) => {
      // Only clear if we're leaving THIS target (dragover on a sibling will reset target to that one)
      setTarget(prev => (prev && prev.skid === slot.skid && prev.slot_index === slot.slot_index ? null : prev));
    },
    onDrop: async (e: React.DragEvent, slot: ShelfSlot) => {
      e.preventDefault();
      const from = source;
      if (!from) return;
      if (from.skid === slot.skid && from.slot_index === slot.slot_index) return;
      setBusy(true); setError(null);
      try {
        await swapSlots(from, { skid: slot.skid, slot_index: slot.slot_index });
        setDirty(true); setSaved(false);
      } catch (err) { setError((err as Error).message); }
      finally { setBusy(false); setSource(null); setTarget(null); }
    },
  };

  const handleConfirmLayout = async () => {
    setBusy(true); setError(null);
    try { await confirmShelfLayout(); setDirty(false); setSaved(true); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

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
        <button
          className={`${styles.confirmLayoutBtn} ${saved ? styles.saved : ''}`}
          onClick={handleConfirmLayout}
          disabled={!dirty || busy}
        >
          {busy ? 'Saving…' : saved ? 'Saved ✓' : 'Confirm layout'}
        </button>
        {error && <span style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</span>}
      </div>
      <div className={styles.skidGrid}>
        {skidKeys.map(skid => (
          <SkidCard
            key={skid}
            skid={skid}
            slots={groupedBySkid.get(skid) ?? []}
            dragSource={source}
            dragTarget={target}
            handlers={handlers}
          />
        ))}
      </div>
      <ReworksPanel />
    </div>
  );
}
