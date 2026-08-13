import { useEffect, useState } from 'react';
import {
  previewCustomerRename, renameCustomer, renameRowCount,
  type Customer, type CustomerRenameResult,
} from '../../lib/customers';
import { PanelSection, PanelRow } from './Panel';
import styles from './Customers.module.css';

// Correcting a name rewrites the denormalized customer_name on up to eleven
// other tables, so Save previews first and waits for a confirm — the operator
// sees the blast radius before a multi-table write. See NameSection's spec:
// docs/superpowers/specs/2026-08-13-customer-name-editing-design.md

/** "service_tickets" → "service tickets" */
function tableLabel(table: string): string {
  return table.replace(/_/g, ' ');
}

export function NameSection({ customer, onChanged }: {
  customer: Customer;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState(customer.first_name ?? '');
  const [last, setLast] = useState(customer.last_name ?? '');
  const [preview, setPreview] = useState<CustomerRenameResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset the draft when we switch customer, or when the row changes underneath
  // us (another operator's edit arriving over realtime).
  useEffect(() => {
    setEditing(false);
    setPreview(null);
    setFirst(customer.first_name ?? '');
    setLast(customer.last_name ?? '');
    setErr(null);
  }, [customer.id, customer.first_name, customer.last_name]);

  const dirty =
    first.trim() !== (customer.first_name ?? '').trim() ||
    last.trim()  !== (customer.last_name  ?? '').trim();

  const runPreview = async () => {
    setBusy(true); setErr(null);
    try {
      setPreview(await previewCustomerRename(customer.id, first, last));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    setBusy(true); setErr(null);
    try {
      await renameCustomer(customer.id, first, last);
      setPreview(null);
      setEditing(false);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const cancelEdit = () => {
    setFirst(customer.first_name ?? '');
    setLast(customer.last_name ?? '');
    setPreview(null);
    setErr(null);
    setEditing(false);
  };

  if (!editing) {
    return (
      <PanelSection title="Name">
        <PanelRow label="First name" value={customer.first_name} />
        <PanelRow label="Last name" value={customer.last_name} />
        <div style={{ marginTop: 6 }}>
          <button className={styles.linkBtn} onClick={() => setEditing(true)}>
            {customer.full_name.trim() ? 'Edit name' : 'Add a name'}
          </button>
        </div>
      </PanelSection>
    );
  }

  return (
    <PanelSection title="Name">
      <div className={styles.kvLabel} style={{ marginBottom: 4 }}>First name</div>
      <input className={styles.searchInput} placeholder="First name"
        value={first} disabled={busy} onChange={e => setFirst(e.target.value)} />
      <div className={styles.kvLabel} style={{ margin: '6px 0 4px' }}>Last name</div>
      <input className={styles.searchInput} placeholder="Last name"
        value={last} disabled={busy} onChange={e => setLast(e.target.value)} />

      <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
        <button className={styles.linkBtn} disabled={busy || !dirty} onClick={() => void runPreview()}>
          {busy && !preview ? 'Checking…' : 'Save'}
        </button>
        <button className={styles.linkBtn} disabled={busy} onClick={cancelEdit}>Cancel</button>
      </div>

      {err && <div className={styles.toastError} style={{ marginTop: 6 }}>{err}</div>}

      {preview && (
        <RenameConfirm
          preview={preview}
          busy={busy}
          onConfirm={() => void apply()}
          onCancel={() => setPreview(null)}
        />
      )}
    </PanelSection>
  );
}

function RenameConfirm({ preview, busy, onConfirm, onCancel }: {
  preview: CustomerRenameResult;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const total = renameRowCount(preview);
  const tables = Object.entries(preview.updated).sort((a, b) => b[1] - a[1]);

  return (
    <div className={styles.panelBackdrop} onClick={onCancel}>
      <div className={styles.panel} style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <div className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>
            Rename “{preview.old_name || 'this customer'}” → “{preview.new_name}”?
          </h2>
        </div>
        <div className={styles.panelBody}>
          {total === 0 ? (
            <div className={styles.emptyRow}>
              No other records carry this name — only the customer record changes.
            </div>
          ) : (
            <>
              <div className={styles.kvLabel} style={{ marginBottom: 6 }}>
                This also updates the name on {total} related {total === 1 ? 'record' : 'records'}:
              </div>
              {tables.map(([table, n]) => (
                <div key={table} className={styles.kvRow}>
                  <span className={styles.kvLabel}>{tableLabel(table)}</span>
                  <span className={styles.kvValue}>{n}</span>
                </div>
              ))}
            </>
          )}

          {preview.ambiguous && (
            <div className={styles.toastError} style={{ marginTop: 10 }}>
              <strong>
                {preview.skipped.length} unlinked{' '}
                {preview.skipped.length === 1 ? 'record is' : 'records are'} left unchanged.
              </strong>
              <div style={{ marginTop: 4 }}>
                Another customer also goes by “{preview.old_name}”, so records matched
                only by name can't be told apart. Fix those by hand:
              </div>
              {preview.skipped.length > 0 && (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {preview.skipped.map(s => (
                    <li key={`${s.table}:${s.id}`}>
                      {tableLabel(s.table)} <span className={styles.mono}>{s.id}</span>
                      {s.label ? ` — ${s.label}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className={styles.linkBtn} disabled={busy} onClick={onConfirm}>
              {busy ? 'Renaming…' : 'Rename'}
            </button>
            <button className={styles.linkBtn} disabled={busy} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
