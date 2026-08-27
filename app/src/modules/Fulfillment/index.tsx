import { useNavigate, useParams } from 'react-router-dom';
import Queue from './queue';
import Shelf from './shelf';
import History from './history';
import { ReturnsTab } from '../PostShipment/ReturnsTab';
import { RefundsTab } from '../PostShipment/RefundsTab';
// The replacement queue lives in Service/ (it leans on Service.module.css +
// TicketDetailPanel for the ticket-triage section) but is rendered here —
// same arrangement as the PostShipment tabs above.
import ReplacementTab from '../Service/ReplacementTab';
import { CancellationsTab } from '../PostShipment/CancellationsTab';
import { ClaimsTab } from '../PostShipment/ClaimsTab';
import { DeliveryMapTab } from '../PostShipment/DeliveryMapTab';
import { useIsMobile } from '../../lib/useMediaQuery';
import { MobileTabbedModule, type MobileTab } from '../../components/MobileTabbedModule';
import { PageHeader, Tabs } from '../../components/ui';
import styles from './Fulfillment.module.css';

type Tab =
  | 'queue' | 'shelf' | 'history'
  | 'returns' | 'refunds' | 'replacements' | 'cancellations' | 'claims'
  | 'map';

const VALID_TABS: Tab[] = [
  'queue', 'shelf', 'history',
  'returns', 'refunds', 'replacements', 'cancellations', 'claims',
  'map',
];

// Two groups: what is going out, and what is coming back. The seam used to be
// a literal "|" between two of the nine buttons; `startsGroup` draws it now,
// and the labels lost their redundant nouns ("Fulfillment Queue" inside the
// Fulfillment module, "Inventory Shelf" beside it).
const FULFILLMENT_TABS: { key: Tab; label: string; startsGroup?: boolean }[] = [
  { key: 'queue',         label: 'Queue' },
  { key: 'shelf',         label: 'Shelf' },
  { key: 'history',       label: 'History' },
  { key: 'map',           label: 'Delivery map', startsGroup: true },
  { key: 'returns',       label: 'Returns' },
  { key: 'refunds',       label: 'Refunds' },
  { key: 'replacements',  label: 'Replacements' },
  { key: 'cancellations', label: 'Cancellations' },
  { key: 'claims',        label: 'Claims' },
];

export default function Fulfillment() {
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const active: Tab = (VALID_TABS.includes(tab as Tab) ? tab : 'queue') as Tab;

  if (isMobile) {
    const mobileTabs: MobileTab<Tab>[] = [
      { key: 'queue',         label: 'Fulfillment Queue', subtitle: 'Active orders moving through assign → ship', icon: '📦', iconBg: '#fff3e0', content: <Queue /> },
      { key: 'shelf',         label: 'Inventory Shelf',   subtitle: 'Skid assignments + on-hand units',           icon: '🪜', iconBg: '#e3f0fb', content: <Shelf /> },
      { key: 'history',       label: 'History',           subtitle: 'Fulfilled orders, searchable',               icon: '📜', iconBg: '#f5f1eb', content: <History /> },
      { key: 'map',           label: 'Delivery Map',      subtitle: 'Open shipments on a map',                    icon: '🗺️', iconBg: '#e6f4ea', content: <DeliveryMapTab /> },
      { key: 'returns',       label: 'Returns',           subtitle: 'Inbound returns, inspection queue',          icon: '↩️', iconBg: '#fff3e0', content: <ReturnsTab /> },
      { key: 'refunds',       label: 'Refunds',           subtitle: 'Awaiting manager + finance approval',        icon: '💵', iconBg: '#fef1f0', content: <RefundsTab /> },
      { key: 'replacements',  label: 'Replacements',      subtitle: 'Warranty replacements + parts queue',        icon: '🔁', iconBg: '#fef1f0', content: <ReplacementTab /> },
      { key: 'cancellations', label: 'Cancellations',     subtitle: 'Customer-initiated cancellations',           icon: '❌', iconBg: '#f5f1eb', content: <CancellationsTab /> },
      { key: 'claims',        label: 'Claims',            subtitle: 'Shipping-damage claims + photos',            icon: '📸', iconBg: '#fffaf0', content: <ClaimsTab /> },
    ];
    return (
      <div className={styles.layout}>
        <MobileTabbedModule
          tabs={mobileTabs}
          activeKey={tab ? active : null}
          onChange={(k) => navigate(k ? `/fulfillment/${k}` : '/fulfillment')}
        />
      </div>
    );
  }

  return (
    <div className={styles.layout}>
      <PageHeader
        title="Fulfillment"
        meta="Everything between a confirmed order and a closed case."
      />
      <Tabs
        ariaLabel="Fulfillment sections"
        items={FULFILLMENT_TABS}
        active={active}
        onChange={(k) => navigate(`/fulfillment/${k}`)}
      />
      <div className={styles.tabPanel}>
        {active === 'queue'         ? <Queue /> :
         active === 'shelf'         ? <Shelf /> :
         active === 'history'       ? <History /> :
         active === 'map'           ? <DeliveryMapTab /> :
         active === 'returns'       ? <ReturnsTab /> :
         active === 'refunds'       ? <RefundsTab /> :
         active === 'replacements'  ? <ReplacementTab /> :
         active === 'cancellations' ? <CancellationsTab /> :
         active === 'claims'        ? <ClaimsTab /> :
         <Queue />}
      </div>
    </div>
  );
}
