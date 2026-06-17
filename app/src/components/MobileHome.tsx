import { NavCard, NavGroupLabel } from './NavCard';
import styles from './MobileHome.module.css';
import { useAuth } from '../lib/auth';
import { canView } from '../lib/permissions';

// Module picker for phones. Vertical scroll of clickable cards instead of the
// desktop horizontal nav strip. Cards are grouped into "Today's attention"
// (operator-action surfaces) and "Workspace" (reference surfaces).
//
// Count pills are intentionally omitted from V1 — wiring per-module unread
// counts here would require loading every module's data hooks at home, which
// is expensive. A follow-up can introduce a single useAttentionCounts() hook.

const ATTENTION = [
  { to: '/order-review',  title: 'Sales',         subtitle: 'Pending orders, address verification, flags',     icon: '🛒', iconBg: '#fef1f0' },
  { to: '/service',       title: 'Service',        subtitle: 'Support tickets, onboarding, replacements',       icon: '🎫', iconBg: '#fff3e0' },
  { to: '/fulfillment',   title: 'Fulfillment',    subtitle: 'Queue, shelf, label & ship',                      icon: '📦', iconBg: '#e3f0fb' },
];

const WORKSPACE = [
  { to: '/stock',        title: 'Stock',        subtitle: 'Units, parts, batches',                 icon: '📊', iconBg: '#e6f4ea' },
  { to: '/customers',    title: 'Customers',    subtitle: 'Directory & journey stages',            icon: '👥', iconBg: '#f5f1eb' },
  { to: '/lovely',       title: 'Lovely',       subtitle: 'Lovely app users',                      icon: '🌱', iconBg: '#e6f4ea' },
  { to: '/marketing',    title: 'Marketing',    subtitle: 'Campaign attribution, CAC dashboard',   icon: '📣', iconBg: '#fef9f0' },
  { to: '/team',         title: 'Team',         subtitle: 'Activity log & team tools',             icon: '👤', iconBg: '#f5f1eb' },
];

const MARKETING_ROLES = ['pedrum@virgohome.io', 'huayi@virgohome.io', 'george@virgohome.io'];

export function MobileHome() {
  const { user, role } = useAuth();
  const userEmail = user?.email?.toLowerCase() ?? '';

  const workspace = WORKSPACE.filter(m => {
    if (m.to === '/marketing') return MARKETING_ROLES.includes(userEmail);
    return true;
  });

  return (
    <div className={styles.screen}>
      <NavGroupLabel>Today's attention</NavGroupLabel>
      {ATTENTION.map(m => (
        <NavCard key={m.to} to={m.to} title={m.title} subtitle={m.subtitle} icon={m.icon} iconBg={m.iconBg} />
      ))}

      <NavGroupLabel>Workspace</NavGroupLabel>
      {workspace.map(m => (
        <NavCard key={m.to} to={m.to} title={m.title} subtitle={m.subtitle} icon={m.icon} iconBg={m.iconBg} />
      ))}

      {canView(role, 'finance') && (
        <NavCard
          to="/finance"
          title="Finance"
          subtitle="QBO journals, production & sales projections"
          icon="💰"
          iconBg="#f0fff4"
        />
      )}
    </div>
  );
}

export default MobileHome;
