import React from 'react';
import styles from './Customers.module.css';

// Shared building blocks for the customer detail panel. Extracted from
// index.tsx so panel sections can live in their own files without importing
// from index (which would be circular).

export function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      <div className={styles.sectionBody}>{children}</div>
    </div>
  );
}

export function PanelRow({ label, value, multiline }: {
  label: string;
  value: string | null | undefined;
  multiline?: boolean;
}) {
  return (
    <div className={styles.kvRow}>
      <span className={styles.kvLabel}>{label}</span>
      <span className={multiline ? styles.kvValueMulti : styles.kvValue}>{value || '—'}</span>
    </div>
  );
}
