import { useState } from 'react';
import {
  useCustomerAdditionalUsers, addCustomerAdditionalUser,
  updateCustomerAdditionalUser, removeCustomerAdditionalUser,
  PRIMARY_USER_RELATIONSHIPS,
  type AdditionalUserInput, type CustomerAdditionalUser,
} from '../../lib/customers';
import { PanelSection } from './Panel';
import styles from './Customers.module.css';

// Everyone else in the household who uses the machine. customers.primary_user_*
// holds one person; when the purchaser IS the primary user but a spouse or
// child is also someone we talk to, they go here. Unbounded, so it's a child
// table (customer_additional_users) rather than more columns.
//
// Same field set and same relationship picklist as the primary-user block above
// it — an operator shouldn't have to learn a second way to record a person.

// Sentinel for the picklist's free-text escape. Never stored: picking it just
// reveals the text box, and what's saved is whatever was typed. Mirrors
// OTHER_RELATIONSHIP in index.tsx's PrimaryUserSection.
const OTHER_RELATIONSHIP = 'Other…';

const isListed = (v: string) => (PRIMARY_USER_RELATIONSHIPS as readonly string[]).includes(v);

const EMPTY: AdditionalUserInput = { full_name: '', phone: '', email: '', relationship: '' };

export function AdditionalUsersSection({ customerId }: { customerId: string }) {
  const { users, loading, refresh } = useCustomerAdditionalUsers(customerId);
  // Which row is open in the editor, 'new' for the add form, null for neither.
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<CustomerAdditionalUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (input: AdditionalUserInput, id?: string) => {
    setBusy(true); setErr(null);
    try {
      if (id) await updateCustomerAdditionalUser(id, customerId, input);
      else await addCustomerAdditionalUser(customerId, input);
      setEditing(null);
      await refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const remove = async (user: CustomerAdditionalUser) => {
    setBusy(true); setErr(null);
    try {
      await removeCustomerAdditionalUser(user.id, customerId, user.full_name);
      setConfirmRemove(null);
      await refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <PanelSection title="Other users in the household">
      <div className={styles.kvLabel} style={{ marginBottom: 6 }}>
        Anyone else who uses this machine and that we're in contact with, beyond the
        purchaser and the primary user above.
      </div>

      {loading ? (
        <div className={styles.emptyRow}>Loading…</div>
      ) : users.length === 0 && editing !== 'new' ? (
        <div className={styles.emptyRow}>No other users recorded.</div>
      ) : (
        users.map(user => (
          editing === user.id ? (
            <UserForm
              key={user.id}
              initial={{
                full_name: user.full_name,
                phone: user.phone ?? '',
                email: user.email ?? '',
                relationship: user.relationship ?? '',
              }}
              busy={busy}
              submitLabel="Save"
              onSubmit={input => void save(input, user.id)}
              onCancel={() => { setEditing(null); setErr(null); }}
            />
          ) : (
            <UserRow
              key={user.id}
              user={user}
              disabled={busy || editing !== null}
              onEdit={() => { setEditing(user.id); setErr(null); }}
              onRemove={() => setConfirmRemove(user)}
            />
          )
        ))
      )}

      {editing === 'new' ? (
        <UserForm
          initial={EMPTY}
          busy={busy}
          submitLabel="Add user"
          onSubmit={input => void save(input)}
          onCancel={() => { setEditing(null); setErr(null); }}
        />
      ) : (
        <div style={{ marginTop: 6 }}>
          <button className={styles.linkBtn} disabled={busy || editing !== null}
            onClick={() => { setEditing('new'); setErr(null); }}>
            + Add another user
          </button>
        </div>
      )}

      {err && <div className={styles.toastError} style={{ marginTop: 6 }}>{err}</div>}

      {confirmRemove && (
        <RemoveConfirm
          user={confirmRemove}
          busy={busy}
          onConfirm={() => void remove(confirmRemove)}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </PanelSection>
  );
}

/** One saved household user, read-only. */
function UserRow({ user, disabled, onEdit, onRemove }: {
  user: CustomerAdditionalUser;
  disabled: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const contact = [user.phone, user.email].filter(Boolean).join(' · ');
  return (
    <div className={styles.additionalUser}>
      <div className={styles.additionalUserName}>
        {user.full_name}
        {user.relationship && (
          <span className={styles.muted}> · {user.relationship}</span>
        )}
      </div>
      {contact && <div className={styles.additionalUserContact}>{contact}</div>}
      <div className={styles.additionalUserActions}>
        <button className={styles.linkBtn} disabled={disabled} onClick={onEdit}>Edit</button>
        <button className={styles.linkBtn} disabled={disabled} onClick={onRemove}>Remove</button>
      </div>
    </div>
  );
}

/** Add/edit form. Same four fields as the primary-user block. */
function UserForm({ initial, busy, submitLabel, onSubmit, onCancel }: {
  initial: AdditionalUserInput;
  busy: boolean;
  submitLabel: string;
  onSubmit: (input: AdditionalUserInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.full_name);
  const [phone, setPhone] = useState(initial.phone ?? '');
  const [email, setEmail] = useState(initial.email ?? '');
  const storedRel = initial.relationship ?? '';
  const [relChoice, setRelChoice] = useState(
    storedRel === '' ? '' : isListed(storedRel) ? storedRel : OTHER_RELATIONSHIP,
  );
  const [relOther, setRelOther] = useState(storedRel && !isListed(storedRel) ? storedRel : '');

  const relationship = relChoice === OTHER_RELATIONSHIP ? relOther.trim() : relChoice;

  return (
    <div className={styles.additionalUserForm}>
      <input className={styles.searchInput} placeholder="Full name (e.g. Sarah Lockhart)"
        value={name} disabled={busy} onChange={e => setName(e.target.value)}
        aria-label="Household user full name" />
      <input className={styles.searchInput} style={{ marginTop: 4 }} type="tel"
        placeholder="Phone (optional)"
        value={phone} disabled={busy} onChange={e => setPhone(e.target.value)}
        aria-label="Household user phone" />
      <input className={styles.searchInput} style={{ marginTop: 4 }} type="email"
        placeholder="Email (optional)"
        value={email} disabled={busy} onChange={e => setEmail(e.target.value)}
        aria-label="Household user email" />
      <select className={styles.searchInput} style={{ marginTop: 4 }}
        value={relChoice} disabled={busy}
        onChange={e => setRelChoice(e.target.value)}
        aria-label="Household user's relationship to the purchaser">
        <option value="">Relationship to purchaser (optional)…</option>
        {PRIMARY_USER_RELATIONSHIPS.map(r => <option key={r} value={r}>{r}</option>)}
        <option value={OTHER_RELATIONSHIP}>{OTHER_RELATIONSHIP}</option>
      </select>
      {relChoice === OTHER_RELATIONSHIP && (
        <input className={styles.searchInput} style={{ marginTop: 4 }}
          placeholder="Describe the relationship (e.g. neighbour)"
          value={relOther} disabled={busy} onChange={e => setRelOther(e.target.value)}
          aria-label="Describe the relationship" />
      )}
      <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
        <button className={styles.linkBtn} disabled={busy || !name.trim()}
          onClick={() => onSubmit({ full_name: name, phone, email, relationship })}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        <button className={styles.linkBtn} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Removal is a real delete with no tombstone, so it asks first. */
function RemoveConfirm({ user, busy, onConfirm, onCancel }: {
  user: CustomerAdditionalUser;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className={styles.panelBackdrop} onClick={onCancel}>
      <div className={styles.panel} style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>Remove {user.full_name}?</h2>
        </div>
        <div className={styles.panelBody}>
          <div className={styles.emptyRow}>
            This deletes their contact details from this customer. It can't be undone.
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className={styles.linkBtn} disabled={busy} onClick={onConfirm}>
              {busy ? 'Removing…' : 'Remove'}
            </button>
            <button className={styles.linkBtn} disabled={busy} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
