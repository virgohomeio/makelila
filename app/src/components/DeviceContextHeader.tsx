import { useState } from 'react';
import {
  useDeviceContext,
  computeCoverageState,
  daysRemainingWarranty,
  type CoverageState,
} from '../lib/service';
import { UnitTimeline } from './UnitTimeline';
import styles from './DeviceContextHeader.module.css';

// ── Constants ─────────────────────────────────────────────────────────────────

const CURRENT_FIRMWARE = '1.0.0';
const WARRANTY_EXPIRY_WARN_DAYS = 30;

// Telemetry states that map to each colour.
const TELEMETRY_GREEN  = new Set(['OK', 'NEW_FOOD']);
const TELEMETRY_AMBER  = new Set(['DRY_SOIL', 'SOAKED_SOIL', 'OPEN_LID']);
const TELEMETRY_RED    = new Set(['NOT_MIXING', 'NO_BME_DATA', 'DIAGNOSE']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeMinutes(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (isNaN(diffMs)) return '?';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60)   return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)    return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmt(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString();
}

// ── Sub-chips ─────────────────────────────────────────────────────────────────

interface ChipProps {
  colorClass: string;
  label: string;
  title?: string;
  onClick?: () => void;
  href?: string;
}

function Chip({ colorClass, label, title, onClick, href }: ChipProps) {
  if (href) {
    return (
      <a className={`${styles.chip} ${colorClass}`} href={href} title={title}>
        {label}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={`${styles.chip} ${colorClass}`}
      title={title}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  unitSerial: string | null;
  currentTicketId?: string;
}

export function DeviceContextHeader({ unitSerial, currentTicketId: _currentTicketId }: Props) {
  const ctx = useDeviceContext(unitSerial);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // ── "No unit linked" state ────────────────────────────────────────────
  if (!unitSerial) {
    return (
      <div className={styles.header}>
        <div className={styles.noBanner}>
          No unit linked to this ticket
          <button type="button" className={styles.linkUnitBtn} disabled>
            Link unit
          </button>
        </div>
      </div>
    );
  }

  if (ctx.loading) {
    return (
      <div className={styles.header}>
        <div className={styles.chipRow}>
          <span className={`${styles.chip} ${styles.chipLoading}`}>Loading device context…</span>
        </div>
      </div>
    );
  }

  const toggleDrawer = () => setDrawerOpen(o => !o);

  // ── 1. Firmware chip ────────────────────────────────────────────────────────
  const fw = ctx.unit?.firmware_version ?? null;
  let fwColor = styles.chipGrey;
  let fwLabel = 'Firmware unknown';
  if (fw !== null) {
    fwLabel = fw;
    fwColor = fw === CURRENT_FIRMWARE ? styles.chipGreen : styles.chipAmber;
  }

  // ── 2. Telemetry chip ───────────────────────────────────────────────────────
  let telColor = styles.chipGrey;
  let telLabel = 'No telemetry';
  let telTitle: string | undefined;
  if (ctx.telemetry) {
    const { classified_state, classified_at, is_stale } = ctx.telemetry;
    const ago = relativeMinutes(classified_at);
    if (is_stale) {
      telColor = styles.chipGrey;
      telLabel = `${classified_state} (stale) · ${ago}`;
    } else {
      telLabel = `${classified_state} · ${ago}`;
      if (TELEMETRY_GREEN.has(classified_state))  telColor = styles.chipGreen;
      else if (TELEMETRY_AMBER.has(classified_state)) telColor = styles.chipAmber;
      else if (TELEMETRY_RED.has(classified_state))   telColor = styles.chipRed;
      else telColor = styles.chipGrey;
    }
    if (classified_state === 'NOT_MIXING') {
      telTitle = 'may be false positive — confirm with diagnosis call';
    }
  }

  // ── 3. Open tickets chip ────────────────────────────────────────────────────
  const oc = ctx.openTicketCount;
  const ocColor = oc === 0 ? styles.chipGrey : oc <= 2 ? styles.chipAmber : styles.chipRed;
  const ocLabel = oc === 0 ? 'No prior tickets' : `${oc} open ticket${oc === 1 ? '' : 's'}`;

  // ── 4. Returns chip ─────────────────────────────────────────────────────────
  const rc = ctx.returnCount;
  const rcColor = rc === 0 ? styles.chipGrey : styles.chipAmber;
  const rcLabel = rc === 0 ? 'No returns' : `${rc} return${rc === 1 ? '' : 's'}`;

  // ── 5. Warranty badge ───────────────────────────────────────────────────────
  const reg = ctx.warranty.registration;
  const coverageState: CoverageState = computeCoverageState(reg);
  let warColor = styles.chipGrey;
  let warLabel = 'No registration';
  if (coverageState === 'in_warranty' && reg) {
    const daysLeft = daysRemainingWarranty(reg);
    if (daysLeft <= WARRANTY_EXPIRY_WARN_DAYS) {
      warColor = styles.chipAmber;
      warLabel = `Expires in ${daysLeft}d`;
    } else {
      warColor = styles.chipGreen;
      warLabel = `In warranty (${daysLeft}d)`;
    }
  } else if (coverageState === 'expired') {
    warColor = styles.chipRed;
    warLabel = 'Expired';
  } else if (coverageState === 'voided') {
    warColor = styles.chipRed;
    warLabel = `Voided: ${reg?.voided_reason ?? ''}`;
  }

  // ── 6. Last technician ──────────────────────────────────────────────────────
  const techName = ctx.unit?.technician ?? null;
  const qcDate = ctx.unit?.status_updated_at ?? ctx.unit?.test_report_uploaded_at ?? null;
  const techLine =
    techName || qcDate
      ? `Last tech: ${techName ?? '—'} · QC: ${fmt(qcDate)}`
      : null;

  return (
    <div className={styles.header}>
      <div className={styles.chipRow}>
        {/* Firmware */}
        <Chip
          colorClass={fwColor}
          label={fwLabel}
          onClick={toggleDrawer}
        />

        {/* Telemetry */}
        <Chip
          colorClass={telColor}
          label={telLabel}
          title={telTitle}
          onClick={toggleDrawer}
        />

        {/* Open tickets */}
        <Chip
          colorClass={ocColor}
          label={ocLabel}
          href={oc > 0 ? `#/service?unit_serial=${encodeURIComponent(unitSerial)}` : undefined}
          onClick={oc === 0 ? toggleDrawer : undefined}
        />

        {/* Returns */}
        <Chip
          colorClass={rcColor}
          label={rcLabel}
          onClick={toggleDrawer}
        />

        {/* Warranty */}
        <Chip
          colorClass={warColor}
          label={warLabel}
          onClick={toggleDrawer}
        />
      </div>

      {techLine && (
        <div className={styles.techLine}>{techLine}</div>
      )}

      {/* Expansion drawer — UnitTimeline in compact mode.
          UnitTimeline is only mounted when open so tests can assert on presence.
          The CSS max-height transition animates show/hide in the browser. */}
      <div className={`${styles.drawer} ${drawerOpen ? styles.drawerOpen : ''}`}>
        {drawerOpen && (
          <div className={styles.drawerInner}>
            <UnitTimeline unitSerial={unitSerial} density="compact" />
          </div>
        )}
      </div>
    </div>
  );
}
