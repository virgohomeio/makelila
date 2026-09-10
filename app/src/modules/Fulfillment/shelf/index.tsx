import { useMemo, useState } from 'react';
import {
  useShelf, swapSlots, confirmShelfLayout,
  SHELF_SECTIONS, type ShelfSlot, type ShelfLocation,
} from '../../../lib/fulfillment';
import { SkidCard } from './SkidCard';
import { ReworksPanel } from './ReworksPanel';
import styles from '../Fulfillment.module.css';

type Pos = { skid: string; slot_index: number };

/** A1 < A2 < A10 (not A1 < A10 < A2), and FS-P01 < FS-P14 < FS-S2. */
function compareSkids(a: string, b: string): number {
  const split = (s: string) => s.match(/(\d+|\D+)/g) ?? [s];
  const as = split(a), bs = split(b);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i], y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { const d = parseInt(x, 10) - parseInt(y, 10); if (d) return d; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The serial the Assign step will reach for next.
 *
 *  Scoped to one section at a time, walking SHELF_SECTIONS in order, so the
 *  team's own floor is drained before we ask the 3PL to pick. Within a section
 *  the front row (slots 3-4) goes first, then by group, then by slot — the
 *  order someone physically unloading a skid would follow. */
function autoNextSerial(byLocation: Map<ShelfLocation, ShelfSlot[]>): string | null {
  for (const section of SHELF_SECTIONS) {
    const slots = byLocation.get(section.location) ?? [];
    const sorted = [...slots].sort((a, b) => {
      const aFront = a.slot_index >= 3 ? 0 : 1;
      const bFront = b.slot_index >= 3 ? 0 : 1;
      if (aFront !== bFront) return aFront - bFront;
      const s = compareSkids(a.skid, b.skid);
      if (s !== 0) return s;
      return a.slot_index - b.slot_index;
    });
    const hit = sorted.find(s => s.status === 'available' && s.serial)?.serial;
    if (hit) return hit;
  }
  return null;
}

export default function Shelf() {
  const { slots, loading } = useShelf();
  const [source, setSource] = useState<Pos | null>(null);
  const [target, setTarget] = useState<Pos | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byLocation = useMemo(() => {
    const m = new Map<ShelfLocation, ShelfSlot[]>();
    for (const s of slots) {
      if (!m.has(s.location)) m.set(s.location, []);
      m.get(s.location)!.push(s);
    }
    return m;
  }, [slots]);

  const stats = useMemo(() => {
    const out = { available: 0, reserved: 0, rework: 0, empty: 0, held: 0 };
    for (const s of slots) out[s.status]++;
    return out;
  }, [slots]);
  const nextSerial = useMemo(() => autoNextSerial(byLocation), [byLocation]);

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
      // The DB rejects a cross-building swap too, but catching it here keeps
      // the operator from watching a drag "work" and then snap back.
      const fromSlot = slots.find(s => s.skid === from.skid && s.slot_index === from.slot_index);
      if (fromSlot && fromSlot.location !== slot.location) {
        setError(`A machine can't be dragged from ${fromSlot.location} to ${slot.location} — move it physically first, then update its location in Stock.`);
        setSource(null); setTarget(null);
        return;
      }
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
          <strong>{slots.length} slots</strong> · {stats.available} available · {stats.reserved} reserved · {stats.rework} rework · {stats.held} held · {stats.empty} empty
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

      {SHELF_SECTIONS.map(section => {
        const sectionSlots = byLocation.get(section.location) ?? [];
        const groups = new Map<string, ShelfSlot[]>();
        for (const s of sectionSlots) {
          if (!groups.has(s.skid)) groups.set(s.skid, []);
          groups.get(s.skid)!.push(s);
        }
        const skidKeys = Array.from(groups.keys()).sort(compareSkids);
        const filled = sectionSlots.filter(s => s.serial).length;

        return (
          <section key={section.location} className={styles.shelfSection}>
            <div className={styles.shelfSectionHead}>
              <h3 className={styles.shelfSectionTitle}>{section.location}</h3>
              <span className={styles.shelfSectionMeta}>
                {sectionSlots.length
                  ? `${filled} unit${filled === 1 ? '' : 's'} · ${skidKeys.length} ${section.groupNoun}${skidKeys.length === 1 ? '' : 's'}`
                  : 'no stock'}
              </span>
              <span className={styles.shelfSectionBlurb}>{section.blurb}</span>
            </div>

            {skidKeys.length === 0 ? (
              <div className={styles.shelfSectionEmpty}>
                {section.pending
                  ? 'Nothing here yet — this site is not integrated.'
                  : 'No slots at this location.'}
              </div>
            ) : (
              <div className={styles.skidGrid}>
                {skidKeys.map(skid => {
                  const groupSlots = groups.get(skid)!;
                  return (
                    <SkidCard
                      key={skid}
                      skid={skid}
                      slots={groupSlots}
                      location={section.location}
                      // Flex Space groups that aren't a real pallet are the
                      // shipments the manufacturer sent with no manifest.
                      note={skid.startsWith('FS-S') ? 'no pallet manifest' : undefined}
                      dragSource={source}
                      dragTarget={target}
                      handlers={handlers}
                    />
                  );
                })}
              </div>
            )}
          </section>
        );
      })}

      <ReworksPanel />
    </div>
  );
}
