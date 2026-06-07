import { NavCard, NavGroupLabel } from './NavCard';
import styles from './MobileHome.module.css';

// Module picker for phones. Vertical scroll of clickable cards instead of the
// desktop horizontal nav strip. Cards are grouped into "Today's attention"
// (operator-action surfaces) and "Workspace" (reference surfaces).
//
// Count pills are intentionally omitted from V1 — wiring per-module unread
// counts here would require loading every module's data hooks at home, which
// is expensive. A follow-up can introduce a single useAttentionCounts() hook.

const ATTENTION = [
  { to: '/order-review',  title: 'Order Review',  subtitle: 'Pending orders, address verification, flags',     icon: '🛒', iconBg: '#fef1f0' },
  { to: '/service',       title: 'Service',       subtitle: 'Support tickets, onboarding, replacements',       icon: '🎫', iconBg: '#fff3e0' },
  { to: '/fulfillment',   title: 'Fulfillment',   subtitle: 'Queue, shelf, label & ship',                      icon: '📦', iconBg: '#e3f0fb' },
  { to: '/post-shipment', title: 'Post-Shipment', subtitle: 'Returns, refunds, replacements, cancellations',   icon: '↩️', iconBg: '#fef1f0' },
];

const WORKSPACE = [
  { to: '/build',        title: 'Build',        subtitle: 'Manufacturing pipeline · per-unit QC',  icon: '🏗️', iconBg: '#e6f4ea' },
  { to: '/stock',        title: 'Stock',        subtitle: 'Units, parts, batches',                 icon: '📊', iconBg: '#e6f4ea' },
  { to: '/customers',    title: 'Customers',    subtitle: 'Directory & journey stages',            icon: '👥', iconBg: '#f5f1eb' },
  { to: '/templates',    title: 'Templates',    subtitle: 'Email & SMS template editor',           icon: '📝', iconBg: '#f5f1eb' },
  { to: '/activity-log', title: 'Activity Log', subtitle: 'Audit trail',                           icon: '📜', iconBg: '#f5f1eb' },
  { to: '/dashboard',    title: 'Dashboard',    subtitle: 'Live device telemetry',                 icon: '📈', iconBg: '#e3f0fb' },
];

export function MobileHome() {
  return (
    <div className={styles.screen}>
      <NavGroupLabel>Today's attention</NavGroupLabel>
      {ATTENTION.map(m => (
        <NavCard key={m.to} to={m.to} title={m.title} subtitle={m.subtitle} icon={m.icon} iconBg={m.iconBg} />
      ))}

      <NavGroupLabel>Workspace</NavGroupLabel>
      {WORKSPACE.map(m => (
        <NavCard key={m.to} to={m.to} title={m.title} subtitle={m.subtitle} icon={m.icon} iconBg={m.iconBg} />
      ))}
    </div>
  );
}

export default MobileHome;
