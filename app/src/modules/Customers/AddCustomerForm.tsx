import { useEffect, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { createCustomer, EMPTY_NEW_CUSTOMER, type NewCustomerInput } from '../../lib/customers';
import { PanelSection } from './Panel';
import panel from './Customers.module.css';
import styles from './AddCustomerForm.module.css';

// Manually adding a customer from the Directory, for the person who exists in
// the real world but not in anything we sync from: a phone lead, a trade-show
// contact, a machine sold outside Shopify, a household member who needs a
// record of their own. Every other row in public.customers arrives from a sync.
//
// This is the same right-hand drawer as the customer panel rather than a
// centred modal — creating a record and filling it in are one task, and the
// panel the operator lands in afterwards is the drawer they just typed into.
// Spec: docs/superpowers/specs/2026-09-24-manual-add-customer-design.md

/** A labelled control. The placeholder is an example, never the label: it
 *  disappears the moment anything is typed, so a half-filled form written that
 *  way can't be read back. */
function Field({ label, optional, children }: {
  label: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>
        {label}
        {optional && <span className={styles.fieldOptional}>optional</span>}
      </span>
      {children}
    </label>
  );
}

export function AddCustomerForm({ onClose, onCreated }: {
  onClose: () => void;
  /** Called with the new customer's id once the row exists. */
  onCreated: (id: string) => void;
}) {
  const [draft, setDraft] = useState<NewCustomerInput>(EMPTY_NEW_CUSTOMER);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = (k: keyof NewCustomerInput) => (
    e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => setDraft(d => ({ ...d, [k]: e.target.value }));

  // A name is the one thing the record can't do without — the directory is
  // sorted and searched by it, so a nameless row can be created and then never
  // found again. Everything else can arrive later.
  const named = draft.first_name.trim() !== '' || draft.last_name.trim() !== '';

  // Escape closes, like the customer panel. Nothing has been written, so a
  // discarded draft costs only the retyping.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      onCreated(await createCustomer(draft));
    } catch (e) {
      // The draft is deliberately left intact. The likeliest rejection is a
      // duplicate email, and clearing ten typed fields to report it would be a
      // worse outcome than the duplicate.
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={panel.panelBackdrop} onClick={() => { if (!busy) onClose(); }}>
      <div
        className={panel.panel}
        role="dialog"
        aria-label="Add customer"
        onClick={e => e.stopPropagation()}
      >
        <div className={panel.panelHeader}>
          <div style={{ minWidth: 0 }}>
            <h2 className={panel.panelTitle}>Add customer</h2>
            <div className={panel.panelSubtitle}>someone no sync has brought in</div>
          </div>
          <button onClick={onClose} className={panel.panelClose} aria-label="Close" disabled={busy}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" />
            </svg>
          </button>
        </div>

        <div className={panel.panelBody}>
          <PanelSection title="Name">
            <p className={styles.note}>
              A household or compound name goes in the first-name box on its own
              — “James &amp; Jill Washington”. Splitting one across both fields
              doubles the surname everywhere the record is shown.
            </p>
            <div className={styles.fieldPair}>
              <Field label="First name">
                <input className={panel.searchInput} placeholder="e.g. Gabriella"
                  value={draft.first_name} disabled={busy} onChange={set('first_name')} autoFocus />
              </Field>
              <Field label="Last name" optional>
                <input className={panel.searchInput} placeholder="e.g. Hottya"
                  value={draft.last_name} disabled={busy} onChange={set('last_name')} />
              </Field>
            </div>
          </PanelSection>

          <PanelSection title="Contact">
            <p className={styles.note}>
              Orders, tickets and refund cards are matched to a customer by
              email. Leave it blank rather than guessing — a wrong address
              quietly attaches someone else’s history to this record.
            </p>
            <Field label="Email" optional>
              <input className={panel.searchInput} type="email" placeholder="name@example.com"
                value={draft.email} disabled={busy} onChange={set('email')} />
            </Field>
            <Field label="Phone" optional>
              <input className={panel.searchInput} type="tel" placeholder="e.g. 519-555-0142"
                value={draft.phone} disabled={busy} onChange={set('phone')} />
            </Field>
          </PanelSection>

          <PanelSection title="Address">
            <Field label="Street address" optional>
              <input className={panel.searchInput} placeholder="e.g. 12 Elm St"
                value={draft.address_line} disabled={busy} onChange={set('address_line')} />
            </Field>
            <div className={styles.fieldPair}>
              <Field label="City" optional>
                <input className={panel.searchInput} placeholder="e.g. Toronto"
                  value={draft.city} disabled={busy} onChange={set('city')} />
              </Field>
              <Field label="Province / State" optional>
                <input className={panel.searchInput} placeholder="e.g. ON"
                  value={draft.region} disabled={busy} onChange={set('region')} />
              </Field>
            </div>
            <div className={styles.fieldPair}>
              <Field label="Postal / ZIP" optional>
                <input className={panel.searchInput} placeholder="e.g. M4B 1B3"
                  value={draft.postal_code} disabled={busy} onChange={set('postal_code')} />
              </Field>
              <Field label="Country" optional>
                {/* Two letters: the directory's country chips test for exactly
                    'CA' and 'US', so "Canada" here would file the row under
                    Other. */}
                <input className={panel.searchInput} placeholder="CA or US" maxLength={2}
                  value={draft.country} disabled={busy} onChange={set('country')} />
              </Field>
            </div>
          </PanelSection>

          <PanelSection title="Notes">
            <p className={styles.note}>
              Where this person came from, so the next operator isn’t left
              guessing why a record exists with no order behind it.
            </p>
            <Field label="Notes" optional>
              <textarea className={`${panel.searchInput} ${styles.textarea}`} rows={3}
                placeholder="e.g. Trade-show lead, Guelph, Sept 2026"
                value={draft.notes} disabled={busy} onChange={set('notes')} />
            </Field>
          </PanelSection>

          <div className={styles.actions}>
            <button className={panel.linkBtn} disabled={busy || !named} onClick={() => void save()}>
              {busy ? 'Adding…' : 'Add customer'}
            </button>
            <button className={panel.linkBtn} disabled={busy} onClick={onClose}>Cancel</button>
          </div>
          {!named && <p className={styles.note}>Enter a name to add the record.</p>}
          {err && <div className={styles.error}>{err}</div>}
        </div>
      </div>
    </div>
  );
}
