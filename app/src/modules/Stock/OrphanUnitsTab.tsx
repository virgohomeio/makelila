import { useMemo, useState } from 'react';
import { useUnits, linkUnitToCustomer, type Unit } from '../../lib/stock';
import { useCustomers, type Customer } from '../../lib/customers';
import styles from './Stock.module.css';

// Backlog #69 — operator cleanup for the ~47 units whose customer_name is
// set but couldn't be resolved to a canonical customer by the #67/#68
// backfill (mostly customers in Shopify/HubSpot that were never imported,
// or names with "(test)" suffixes that distinguish a special shipment).
export function OrphanUnitsTab() {
  const { units, loading: uLoading } = useUnits();
  const { customers, loading: cLoading } = useCustomers();

  const orphans = useMemo(() =>
    units.filter(u => u.customer_name != null && u.customer_id == null && !u.is_team_test)
         .sort((a, b) => a.serial.localeCompare(b.serial)),
    [units]);

  if (uLoading || cLoading) return <div className={styles.loading}>Loading…</div>;

  return (
    <div className={styles.orphanLayout}>
      <header className={styles.orphanHeader}>
        <h2>Unlinked units</h2>
        <p className={styles.orphanIntro}>
          {orphans.length === 0 ? (
            <>Every customer-assigned unit has a canonical customer link. Nothing to clean up here.</>
          ) : (
            <>
              These {orphans.length} units have a customer_name set on the unit but no canonical{' '}
              <code>customer_id</code> link to a record in the Customers table. Either the customer was
              never imported (mostly Shopify/HubSpot rows that didn't sync), or the name has a context
              suffix like "(test)" that the auto-resolver can't disambiguate. Use the picker below to
              link each unit to its real customer; the trigger keeps the name as-is so context isn't lost.
            </>
          )}
        </p>
      </header>

      {orphans.length > 0 && (
        <table className={styles.orphanTable}>
          <thead>
            <tr>
              <th>Serial</th>
              <th>Customer name on unit</th>
              <th>Status</th>
              <th style={{ width: 360 }}>Link to canonical customer</th>
            </tr>
          </thead>
          <tbody>
            {orphans.map(u => (
              <OrphanRow key={u.serial} unit={u} customers={customers} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function OrphanRow({ unit, customers }: { unit: Unit; customers: Customer[] }) {
  const [search, setSearch] = useState(unit.customer_name ?? '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || q.length < 2) return [];
    return customers
      .filter(c => c.full_name.toLowerCase().includes(q)
                || (c.email ?? '').toLowerCase().includes(q))
      .slice(0, 5);
  }, [customers, search]);

  async function link(customerId: string) {
    setBusy(true); setError(null);
    try {
      await linkUnitToCustomer(unit.serial, customerId);
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <tr className={styles.orphanRowDone}>
        <td><code>{unit.serial}</code></td>
        <td>{unit.customer_name}</td>
        <td>{unit.status}</td>
        <td>✓ Linked. Refresh to remove from list.</td>
      </tr>
    );
  }

  return (
    <tr className={styles.orphanRow}>
      <td><code>{unit.serial}</code></td>
      <td>{unit.customer_name}</td>
      <td>{unit.status}</td>
      <td>
        <input
          type="text"
          className={styles.orphanSearch}
          placeholder="Search customers by name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={busy}
        />
        {matches.length > 0 && (
          <ul className={styles.orphanMatchList}>
            {matches.map(c => (
              <li key={c.id}>
                <button
                  type="button"
                  className={styles.orphanMatchBtn}
                  onClick={() => link(c.id)}
                  disabled={busy}
                  title={c.email ?? ''}
                >
                  <strong>{c.full_name}</strong>
                  {c.email && <span className={styles.orphanMatchMeta}> · {c.email}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {search.trim().length >= 2 && matches.length === 0 && (
          <p className={styles.orphanNoMatches}>
            No customer matches. Create the customer record first via the Customers module, then return here.
          </p>
        )}
        {error && <p className={styles.error}>{error}</p>}
      </td>
    </tr>
  );
}
