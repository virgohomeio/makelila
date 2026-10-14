import { useMemo, useState } from 'react';
import {
  assignSerial, claimSerialRange, formatSerial, parseSerialInput, planSerialRange,
  RANGE_SKIP_LABEL,
  type FactoryOrder, type RangeClaimResult, type RangePlan,
} from '../../lib/build';
import type { Batch, Unit } from '../../lib/stock';
import styles from './Build.module.css';

type Mode = 'range' | 'single';

type Props = {
  batches: Pick<Batch, 'id'>[];
  orders: FactoryOrder[];
  units: Pick<Unit, 'serial' | 'batch' | 'po_id'>[];
  onClose: () => void;
};

type FormState = {
  error: string | null;
  plan: RangePlan | null;
  from: number | null;
  to: number | null;
  one: number | null;
};

const BAD_SERIAL = 'Enter a serial like 691 or LL01-00000000691';
const unitsLabel = (n: number) => `${n} unit${n === 1 ? '' : 's'}`;

/** Claim one serial, or a whole range, into a batch and optionally a PO.
 *  Picking a PO fixes the batch to the PO's batch, so a unit can never land in
 *  a batch its PO does not belong to. The range preview is planned against the
 *  units already loaded; claimSerialRange re-reads the database before writing. */
export function ClaimSerialsModal({ batches, orders, units, onClose }: Props) {
  const openOrders = useMemo(() => orders.filter(o => o.status !== 'cancelled'), [orders]);
  const [poId, setPoId] = useState('');
  const [batchPick, setBatchPick] = useState(
    () => batches.find(b => b.id === 'P100')?.id ?? batches[0]?.id ?? '',
  );
  const [mode, setMode] = useState<Mode>('range');
  const [single, setSingle] = useState('');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [result, setResult] = useState<RangeClaimResult | null>(null);

  const po = openOrders.find(o => o.id === poId) ?? null;
  const batch = po ? po.batch : batchPick;
  const poBatchMissing = po != null && !batches.some(b => b.id === po.batch);

  // Everything derived from the form: the parsed input, the plan, and the one
  // error (if any) that blocks the create button.
  const form = useMemo((): FormState => {
    const blank: FormState = { error: null, plan: null, from: null, to: null, one: null };
    if (poBatchMissing) {
      return { ...blank, error: `Batch ${po!.batch} has no batch record yet. Add it on the LILA Units tab first.` };
    }
    if (!batch) return { ...blank, error: 'Pick a batch' };
    if (mode === 'single') {
      const one = parseSerialInput(single);
      return { ...blank, one, error: single.trim() && one == null ? BAD_SERIAL : null };
    }
    const from = parseSerialInput(first);
    const to = parseSerialInput(last);
    if ((first.trim() && from == null) || (last.trim() && to == null)) return { ...blank, error: BAD_SERIAL };
    if (from == null || to == null) return blank;
    try {
      return { ...blank, from, to, plan: planSerialRange({ from, to, batch, poId: po?.id ?? null, existing: units }) };
    } catch (e) {
      return { ...blank, error: (e as Error).message };
    }
  }, [poBatchMissing, po, batch, mode, single, first, last, units]);

  const plan = form.plan;
  const onPo = po ? units.filter(u => u.po_id === po.id).length : 0;
  const afterPo = po && plan ? onPo + plan.create.length + plan.linkPo.length : null;
  const canSubmit = !busy && !form.error && (
    mode === 'single' ? form.one != null : plan != null && plan.create.length + plan.linkPo.length > 0
  );
  const submitLabel = busy ? 'Saving…'
    : mode === 'single' ? 'Create unit'
    : plan && plan.create.length > 0 ? `Create ${unitsLabel(plan.create.length)}`
    : plan && plan.linkPo.length > 0 ? `Link ${unitsLabel(plan.linkPo.length)}`
    : 'Create units';

  async function submit() {
    if (!canSubmit) return;
    setBusy(true); setSaveError(null);
    try {
      if (mode === 'single') {
        await assignSerial({ serial: formatSerial(form.one!), batch, ...(po ? { po_id: po.id } : {}) });
        onClose();
      } else {
        setResult(await claimSerialRange({
          from: form.from!, to: form.to!, batch,
          po: po ? { id: po.id, po_number: po.po_number } : null,
        }));
      }
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()} role="dialog" aria-label="Claim serials">
        <h3 className={styles.modalTitle}>Claim serials</h3>
        {result ? (
          <div className={styles.claimResult}>
            <div><strong>{result.created.length}</strong> created · <strong>{result.linked.length}</strong> linked to PO · <strong>{result.skipped.length}</strong> skipped</div>
            {result.skipped.length > 0 && (
              <ul className={styles.claimSkipped}>
                {result.skipped.map(s => (
                  <li key={s.serial}>{s.serial}: {RANGE_SKIP_LABEL[s.reason]}{s.detail ? ` ${s.detail}` : ''}</li>
                ))}
              </ul>
            )}
            <div className={styles.actionsRow}>
              <button className={styles.btnPrimary} onClick={onClose}>Close</button>
            </div>
          </div>
        ) : (
          <>
            <div className={styles.modalField}>
              <label className={styles.modalLabel} htmlFor="claim-po">Purchase order</label>
              <select id="claim-po" className={styles.input} value={poId} onChange={e => setPoId(e.target.value)}>
                <option value="">No PO</option>
                {openOrders.map(o => (
                  <option key={o.id} value={o.id}>{o.po_number} · {o.batch}</option>
                ))}
              </select>
            </div>
            <div className={styles.modalField}>
              <label className={styles.modalLabel} htmlFor="claim-batch">Batch</label>
              <select
                id="claim-batch"
                className={styles.input}
                value={batch}
                disabled={po != null}
                onChange={e => setBatchPick(e.target.value)}
              >
                {batches.map(b => <option key={b.id} value={b.id}>{b.id}</option>)}
                {poBatchMissing && <option value={po!.batch}>{po!.batch}</option>}
              </select>
            </div>
            <div className={styles.modeToggle} role="group" aria-label="Claim mode">
              <button
                type="button"
                className={`${styles.chip} ${mode === 'range' ? styles.chipActive : ''}`}
                aria-pressed={mode === 'range'}
                onClick={() => setMode('range')}
              >Range</button>
              <button
                type="button"
                className={`${styles.chip} ${mode === 'single' ? styles.chipActive : ''}`}
                aria-pressed={mode === 'single'}
                onClick={() => setMode('single')}
              >One serial</button>
            </div>
            {mode === 'single' ? (
              <div className={styles.modalField}>
                <label className={styles.modalLabel} htmlFor="claim-single">Serial</label>
                <input
                  id="claim-single"
                  className={styles.input}
                  placeholder="LL01-00000000XYZ"
                  value={single}
                  onChange={e => setSingle(e.target.value.toUpperCase())}
                />
              </div>
            ) : (
              <div className={styles.rangeRow}>
                <div className={styles.modalField}>
                  <label className={styles.modalLabel} htmlFor="claim-first">First serial</label>
                  <input id="claim-first" className={styles.input} placeholder="691"
                    value={first} onChange={e => setFirst(e.target.value)} />
                </div>
                <div className={styles.modalField}>
                  <label className={styles.modalLabel} htmlFor="claim-last">Last serial</label>
                  <input id="claim-last" className={styles.input} placeholder="780"
                    value={last} onChange={e => setLast(e.target.value)} />
                </div>
              </div>
            )}
            {plan && (
              <div className={styles.claimPreview}>
                <div>{plan.create.length} new · {plan.linkPo.length} to link · {plan.skipped.length} skipped</div>
                {po && afterPo != null && (
                  <div>PO {po.po_number}: {afterPo} of {po.qty_ordered} ordered after this</div>
                )}
                {po && afterPo != null && afterPo > po.qty_ordered && (
                  <div className={styles.claimWarn}>That is more than PO {po.po_number} ordered.</div>
                )}
              </div>
            )}
            {(form.error || saveError) && <div className={styles.claimError}>{form.error ?? saveError}</div>}
            <div className={styles.actionsRow}>
              <button className={styles.btnPrimary} disabled={!canSubmit} onClick={() => void submit()}>
                {submitLabel}
              </button>
              <button className={styles.btnSecondary} disabled={busy} onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
