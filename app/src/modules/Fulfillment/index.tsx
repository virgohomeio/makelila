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
// Shipping was its own top-level module until 2026-08-28. Its three tabs are
// rendered here now; the files stay in Shipping/ because they carry their own
// stylesheet, which is the same arrangement as the PostShipment and Service
// tabs above.
import { ShippingTab } from '../Shipping/tabs/ShippingTab';
import { InvoicesTab } from '../Shipping/tabs/InvoicesTab';
import { ClaimsTab as CarrierClaimsTab } from '../Shipping/tabs/ClaimsTab';
import { useIsMobile } from '../../lib/useMediaQuery';
import { MobileTabbedModule, type MobileTab } from '../../components/MobileTabbedModule';
import { PageHeader, Tabs } from '../../components/ui';
import styles from './Fulfillment.module.css';

type Tab =
  | 'queue' | 'shelf' | 'history'
  | 'shipping' | 'map' | 'invoices' | 'carrier-claims'
  | 'returns' | 'refunds' | 'replacements' | 'cancellations' | 'claims';

const VALID_TABS: Tab[] = [
  'queue', 'shelf', 'history',
  'shipping', 'map', 'invoices', 'carrier-claims',
  'returns', 'refunds', 'replacements', 'cancellations', 'claims',
];

// Three groups, following a unit's journey: out the door, in the carrier's
// hands, and back again. Absorbing the Shipping module gave the middle group
// its content — booking, the map, the carrier's invoices and the claims we
// file against them all describe the same leg, and they were split across two
// top-level modules only because they were built at different times.
//
// Two tabs are now called Claims, because they genuinely are two different
// things and always were: `carrier-claims` is what WE file against Freightcom
// for damage, loss or delay (lib/shipping), and `claims` is what a CUSTOMER
// submits through the public /shipping-damage form (lib/claims). Merging the
// modules put them in one row, so both had to say which one they are.
const FULFILLMENT_TABS: { key: Tab; label: string; startsGroup?: boolean }[] = [
  // Out the door.
  { key: 'queue',         label: 'Queue' },
  { key: 'shelf',         label: 'Shelf' },
  { key: 'history',       label: 'History' },
  // With the carrier.
  { key: 'shipping',      label: 'Shipping', startsGroup: true },
  { key: 'map',           label: 'Delivery map' },
  { key: 'invoices',      label: 'Invoices' },
  { key: 'carrier-claims', label: 'Carrier claims' },
  // And back again.
  { key: 'returns',       label: 'Returns', startsGroup: true },
  { key: 'refunds',       label: 'Refunds' },
  { key: 'replacements',  label: 'Replacements' },
  { key: 'cancellations', label: 'Cancellations' },
  { key: 'claims',        label: 'Damage claims' },
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
      { key: 'shipping',      label: 'Shipping',          subtitle: 'Quote, book and track with the carrier',     icon: '🚚', iconBg: '#e3f0fb', content: <ShippingTab /> },
      { key: 'map',           label: 'Delivery Map',      subtitle: 'Open shipments on a map',                    icon: '🗺️', iconBg: '#e6f4ea', content: <DeliveryMapTab /> },
      { key: 'invoices',      label: 'Invoices',          subtitle: 'What the carrier actually billed',           icon: '🧾', iconBg: '#fffaf0', content: <InvoicesTab /> },
      { key: 'carrier-claims', label: 'Carrier Claims',   subtitle: 'Damage, loss and delay filed with Freightcom', icon: '📮', iconBg: '#e3f0fb', content: <CarrierClaimsTab /> },
      { key: 'returns',       label: 'Returns',           subtitle: 'Inbound returns, inspection queue',          icon: '↩️', iconBg: '#fff3e0', content: <ReturnsTab /> },
      { key: 'refunds',       label: 'Refunds',           subtitle: 'Awaiting manager + finance approval',        icon: '💵', iconBg: '#fef1f0', content: <RefundsTab /> },
      { key: 'replacements',  label: 'Replacements',      subtitle: 'Warranty replacements + parts queue',        icon: '🔁', iconBg: '#fef1f0', content: <ReplacementTab /> },
      { key: 'cancellations', label: 'Cancellations',     subtitle: 'Customer-initiated cancellations',           icon: '❌', iconBg: '#f5f1eb', content: <CancellationsTab /> },
      { key: 'claims',        label: 'Damage Claims',     subtitle: 'What customers report, with photos',         icon: '📸', iconBg: '#fffaf0', content: <ClaimsTab /> },
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
         active === 'shipping'      ? <ShippingTab /> :
         active === 'map'           ? <DeliveryMapTab /> :
         active === 'invoices'      ? <InvoicesTab /> :
         active === 'carrier-claims' ? <CarrierClaimsTab /> :
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
