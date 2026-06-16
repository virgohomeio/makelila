import { useMemo, useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useActivityLog } from '../../lib/activityLog';
import { Feed } from '../ActivityLog/Feed';
import ActivityLog from '../ActivityLog';
import styles from './Team.module.css';

type Tab = 'team' | 'workflow' | 'activity-log';

const TABS: { key: Tab; label: string }[] = [
  { key: 'team',         label: 'Team' },
  { key: 'workflow',     label: 'Workflow' },
  { key: 'activity-log', label: 'Activity Log' },
];

// ── Team tab ──────────────────────────────────────────────────────────────────

type Member = {
  name: string;
  email: string;
  responsibility: string;
  jobDescription: string;
  modules: { label: string; path: string }[];
};

const MEMBERS: Member[] = [
  {
    name: 'Pedrum',
    email: 'pedrum@virgohome.io',
    responsibility: 'Marketing & Sales',
    jobDescription: 'Manages all marketing channels, ad spend, and pre-sale customer interactions. Owns the Marketing module and Sales pipeline from lead to confirmed order.',
    modules: [
      { label: 'Marketing', path: '/marketing' },
      { label: 'Sales',     path: '/order-review' },
    ],
  },
  {
    name: 'Raymond',
    email: 'raymond@virgohome.io',
    responsibility: 'Operations & Fulfillment',
    jobDescription: 'Manages order fulfillment from queue through shipment. Oversees inventory shelf, skid management, dock operations, and shipping label generation.',
    modules: [
      { label: 'Fulfillment', path: '/fulfillment' },
    ],
  },
  {
    name: 'Junaid',
    email: 'junaid@virgohome.io',
    responsibility: 'Customer Service & Stock',
    jobDescription: 'Handles customer service tickets and manages stock. Owns unit serial tracking, parts inventory, and batch receipt workflows.',
    modules: [
      { label: 'Stock', path: '/stock' },
    ],
  },
  {
    name: 'Reina',
    email: 'reina@virgohome.io',
    responsibility: 'Customer Onboarding & Support',
    jobDescription: 'Leads customer onboarding for new LILA owners, handles inbound support tickets, and conducts 7-day and 30-day follow-up check-ins.',
    modules: [
      { label: 'Service', path: '/service' },
    ],
  },
  {
    name: 'Hua Yi',
    email: 'huayi@virgohome.io',
    responsibility: 'Technology & Finance',
    jobDescription: 'Owns app infrastructure, the Finance module, mobile experience, and cross-cutting engineering. Manages system integrations and data pipeline reliability.',
    modules: [
      { label: 'Customers', path: '/customers' },
    ],
  },
  {
    name: 'George',
    email: 'george@virgohome.io',
    responsibility: 'Finance & Compliance',
    jobDescription: 'Reviews and approves refunds, manages QuickBooks Online integration, and oversees financial reporting, reconciliation, and billing compliance.',
    modules: [
      { label: 'Finance', path: '/finance' },
    ],
  },
];

function initials(name: string): string {
  return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

// ── Workflow tab ──────────────────────────────────────────────────────────────

type WorkflowDef = { memberName: string; moduleLabel: string; steps: string[] };

const DEFAULT_WORKFLOWS: WorkflowDef[] = [
  {
    memberName: 'Pedrum',
    moduleLabel: 'Sales — Order Review',
    steps: [
      'Open Order Review and check the Pending queue for new orders',
      'Click each order to review: customer name, address verdict, freight type, and line items',
      'Verify the shipping address — run "Verify address" if not already checked',
      'For non-house addresses, confirm fit with the customer and tick "Sales confirmed fit"',
      'If everything is correct → click Confirm to approve the order',
      'If details are unclear or missing → click Flag and enter a reason',
      'If waiting on payment, a document, or a customer reply → click Hold',
      'Notify operations in Slack when a batch of approved orders is ready for fulfillment',
    ],
  },
  {
    memberName: 'Pedrum',
    moduleLabel: 'Marketing',
    steps: [
      'Open the Marketing module and review the campaign summary dashboard',
      'Check daily ad spend vs. budget across all active channels',
      'Review CPL and CPA metrics — flag any channel performing below threshold',
      'Log new inbound leads from any channel not auto-captured',
      'Update weekly performance notes for each channel',
      'Adjust creative or audience targeting for underperforming ad sets',
      'Export the monthly channel report for leadership review',
    ],
  },
  {
    memberName: 'Raymond',
    moduleLabel: 'Fulfillment — Queue',
    steps: [
      'Open Fulfillment → Queue tab',
      'Review all orders in "Approved" status — assign each to a technician',
      'Move each unit through stages: Assigned → Testing → Dock → Label → Email → Fulfilled',
      'Run QC test on every unit; document any failures in the unit notes',
      'Generate and print the shipping label once the unit passes QC',
      'Send the shipping confirmation email to the customer from the Email step',
      'Mark the order "Fulfilled" after the unit leaves the dock',
    ],
  },
  {
    memberName: 'Raymond',
    moduleLabel: 'Fulfillment — Shelf',
    steps: [
      'Open Fulfillment → Shelf tab',
      'Review current skid inventory — verify counts match the physical shelf',
      'When a new skid arrives: add a skid record with batch ID and unit count',
      'Pull units off the shelf when they enter the fulfillment queue',
      'Flag any skid with damaged or missing units in the notes field',
      'Reconcile shelf count at the end of each week',
    ],
  },
  {
    memberName: 'Junaid',
    moduleLabel: 'Stock — Units',
    steps: [
      'Open Stock → Units tab to see all serialized units',
      'When a new batch arrives: go to the Batch tab and create a batch receipt',
      'Assign serial numbers to each unit in the batch',
      'Update unit status (Available, Reserved, Shipped, Returned) as it changes',
      'If a unit is returned: receive it in Stock and update the condition',
      'Log any inventory adjustment with a reason and quantity',
    ],
  },
  {
    memberName: 'Junaid',
    moduleLabel: 'Stock — Parts',
    steps: [
      'Open Stock → Parts tab to review component inventory',
      'When parts arrive: add a receipt with part name, SKU, and quantity',
      'Deduct parts used in assembly or repair from inventory',
      'Set low-stock alerts for critical components',
      'Reconcile parts count with the physical inventory monthly',
    ],
  },
  {
    memberName: 'Reina',
    moduleLabel: 'Service — Tickets',
    steps: [
      'Open Service → Tickets tab and review all open tickets by priority',
      'Click a ticket to read the full customer issue and history',
      'Update ticket status to In Progress once you start working on it',
      'Add internal notes as you troubleshoot or gather information',
      'Reply to the customer using the appropriate message template',
      'Mark the ticket Resolved once the issue is fixed; add resolution notes',
      'Escalate to engineering via Slack if the issue is a confirmed product defect',
    ],
  },
  {
    memberName: 'Reina',
    moduleLabel: 'Service — Onboarding',
    steps: [
      'Open Service → Onboarding tab and filter by units recently shipped',
      'Reach out to new owners within 48 hours of delivery to schedule an onboarding call',
      'Walk through the onboarding checklist with the customer during the call',
      'Check each item off the checklist as it is completed',
      'Click "Mark onboarding complete" once all steps are done',
      'Send the post-onboarding follow-up email (7-day template) from the panel',
      'Log a 30-day check-in reminder in Quo or your calendar',
    ],
  },
  {
    memberName: 'Hua Yi',
    moduleLabel: 'Customers',
    steps: [
      'Open Customers and search by name, email, or serial number',
      'Review the customer profile: order history, returns, and service tickets',
      'Update contact info (email, phone) if the customer has provided new details',
      'Check lifecycle stage: ordered → shipped → onboarded → active',
      'Flag customers who are overdue for onboarding or a follow-up',
      'Use the linked Quo thread URL to review recent communications',
    ],
  },
  {
    memberName: 'George',
    moduleLabel: 'Finance — Refunds',
    steps: [
      'Open Finance and review refund requests pending approval',
      'For each request: verify the return reason, unit condition, and refund amount against policy',
      'Confirm no refund is issued before the unit has been received back',
      'Approve or reject the refund — add notes explaining the decision',
      'If approved: record the refund method (Shopify / Sezzle / QBO / e-transfer)',
      'Confirm the refund has been processed in the relevant payment platform',
      'Export the monthly refund summary for reconciliation',
    ],
  },
];

const WF_KEY = 'makelila_workflows_v1';

function loadOverrides(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(WF_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
  } catch { return {}; }
}

function wfId(w: WorkflowDef) { return `${w.memberName}::${w.moduleLabel}`; }

// ─────────────────────────────────────────────────────────────────────────────

export default function Team() {
  const [tab, setTab] = useState<Tab>('team');

  // Team tab state
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const { entries, loading: logLoading } = useActivityLog(300);

  const memberEntries = useMemo(
    () => selectedMember
      ? entries.filter(e => e.actor_name === selectedMember.name)
      : [],
    [entries, selectedMember],
  );

  // Workflow tab state
  const [overrides, setOverrides] = useState<Record<string, string[]>>(loadOverrides);
  const [selectedWf, setSelectedWf] = useState<WorkflowDef | null>(DEFAULT_WORKFLOWS[0]);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editingIdx !== null) editRef.current?.focus();
  }, [editingIdx]);

  function stepsFor(w: WorkflowDef): string[] {
    return overrides[wfId(w)] ?? w.steps;
  }

  function updateStep(w: WorkflowDef, idx: number, value: string) {
    const next = [...stepsFor(w)];
    next[idx] = value;
    const updated = { ...overrides, [wfId(w)]: next };
    setOverrides(updated);
    localStorage.setItem(WF_KEY, JSON.stringify(updated));
  }

  function removeStep(w: WorkflowDef, idx: number) {
    const next = stepsFor(w).filter((_, i) => i !== idx);
    const updated = { ...overrides, [wfId(w)]: next };
    setOverrides(updated);
    localStorage.setItem(WF_KEY, JSON.stringify(updated));
    setEditingIdx(null);
  }

  function addStep(w: WorkflowDef) {
    const next = [...stepsFor(w), ''];
    const updated = { ...overrides, [wfId(w)]: next };
    setOverrides(updated);
    localStorage.setItem(WF_KEY, JSON.stringify(updated));
    setEditingIdx(next.length - 1);
  }

  function resetWorkflow(w: WorkflowDef) {
    const updated = { ...overrides };
    delete updated[wfId(w)];
    setOverrides(updated);
    localStorage.setItem(WF_KEY, JSON.stringify(updated));
    setEditingIdx(null);
  }

  const currentSteps = selectedWf ? stepsFor(selectedWf) : [];
  const isModified = selectedWf ? (overrides[wfId(selectedWf)] !== undefined) : false;

  return (
    <div className={styles.layout}>
      <div className={styles.tabs}>
        {TABS.map(t => (
          <button
            key={t.key}
            className={`${styles.tab} ${tab === t.key ? styles.active : ''}`}
            onClick={() => setTab(t.key)}
          >{t.label}</button>
        ))}
      </div>

      <div className={styles.panel}>
        {tab === 'team' && (
          <div className={styles.teamContent}>
            <div className={styles.teamGrid}>
              {MEMBERS.map(m => (
                <div
                  key={m.email}
                  className={`${styles.memberCard} ${selectedMember?.email === m.email ? styles.memberCardSelected : ''}`}
                  onClick={() => setSelectedMember(prev => prev?.email === m.email ? null : m)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setSelectedMember(prev => prev?.email === m.email ? null : m)}
                >
                  <div className={styles.avatar}>{initials(m.name)}</div>
                  <div className={styles.memberInfo}>
                    <div className={styles.memberName}>{m.name}</div>
                    <div className={styles.memberEmail}>{m.email}</div>
                    <div className={styles.memberResp}>{m.responsibility}</div>
                    <div className={styles.moduleList}>
                      {m.modules.map(mod => (
                        <Link
                          key={mod.path}
                          to={mod.path}
                          className={styles.moduleBadge}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {mod.label}
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {selectedMember && (
              <div className={styles.detailPanel}>
                <div className={styles.detailHeader}>
                  <div className={styles.detailAvatar}>{initials(selectedMember.name)}</div>
                  <div className={styles.detailHeaderInfo}>
                    <div className={styles.detailName}>{selectedMember.name}</div>
                    <div className={styles.detailEmail}>{selectedMember.email}</div>
                  </div>
                  <button className={styles.detailClose} onClick={() => setSelectedMember(null)}>×</button>
                </div>

                <div className={styles.detailSection}>
                  <div className={styles.detailLabel}>Responsibility</div>
                  <div className={styles.detailValue}>{selectedMember.responsibility}</div>
                </div>

                <div className={styles.detailSection}>
                  <div className={styles.detailLabel}>Job Description</div>
                  <div className={styles.detailValue}>{selectedMember.jobDescription}</div>
                </div>

                <div className={styles.detailSection}>
                  <div className={styles.detailLabel}>Activity Log</div>
                  {logLoading
                    ? <div className={styles.detailEmpty}>Loading…</div>
                    : <Feed entries={memberEntries} />
                  }
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'workflow' && (
          <div className={styles.wfLayout}>
            <div className={styles.wfSidebar}>
              {DEFAULT_WORKFLOWS.map(w => (
                <button
                  key={wfId(w)}
                  className={`${styles.wfSideItem} ${selectedWf && wfId(selectedWf) === wfId(w) ? styles.wfSideItemActive : ''}`}
                  onClick={() => { setSelectedWf(w); setEditingIdx(null); }}
                >
                  <div className={styles.wfSideMember}>{w.memberName}</div>
                  <div className={styles.wfSideModule}>{w.moduleLabel}</div>
                </button>
              ))}
            </div>

            {selectedWf && (
              <div className={styles.wfDetail}>
                <div className={styles.wfDetailHeader}>
                  <div>
                    <div className={styles.wfDetailTitle}>{selectedWf.moduleLabel}</div>
                    <div className={styles.wfDetailSub}>{selectedWf.memberName}</div>
                  </div>
                  {isModified && (
                    <button
                      className={styles.wfResetBtn}
                      onClick={() => resetWorkflow(selectedWf)}
                    >Reset to default</button>
                  )}
                </div>

                <p className={styles.wfHint}>Click any step to edit. Edits are saved automatically to this browser.</p>

                <ol className={styles.wfStepList}>
                  {currentSteps.map((step, i) => (
                    <li key={i} className={styles.wfStep}>
                      <span className={styles.wfStepNum}>{i + 1}</span>
                      {editingIdx === i ? (
                        <textarea
                          ref={editRef}
                          className={styles.wfStepInput}
                          value={step}
                          rows={2}
                          onChange={e => updateStep(selectedWf, i, e.target.value)}
                          onBlur={() => setEditingIdx(null)}
                          onKeyDown={e => {
                            if (e.key === 'Escape') setEditingIdx(null);
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); setEditingIdx(null); }
                          }}
                        />
                      ) : (
                        <span
                          className={styles.wfStepText}
                          onClick={() => setEditingIdx(i)}
                          title="Click to edit"
                        >{step || <em className={styles.wfEmpty}>Empty — click to fill in</em>}</span>
                      )}
                      <button
                        className={styles.wfRemoveBtn}
                        onClick={() => removeStep(selectedWf, i)}
                        title="Remove step"
                      >×</button>
                    </li>
                  ))}
                </ol>

                <button
                  className={styles.wfAddBtn}
                  onClick={() => addStep(selectedWf)}
                >+ Add step</button>
              </div>
            )}
          </div>
        )}

        {tab === 'activity-log' && <ActivityLog />}
      </div>
    </div>
  );
}
