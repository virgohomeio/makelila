import { useState } from 'react';
import styles from './Products.module.css';
import {
  STAGES, PRODUCTS, RD_PROJECTS, isProBom,
  type Product, type StageItem, type BomItem, type ProBom,
} from './data';

/* ── helpers ──────────────────────────────────────────────────────────────── */
const SEV_LABEL: Record<string, string>  = { critical:'C', high:'H', medium:'M', low:'L' };
const SEV_CLASS: Record<string, string>  = {
  critical: styles.sevCrit, high: styles.sevHigh, medium: styles.sevMed, low: styles.sevLow,
};
const PMF_CLS: Record<string, string> = {
  ok: styles.pmfOk, warn: styles.pmfWarn, crit: styles.pmfCrit, na: styles.pmfNa,
};
const RD_STATUS_CLS: Record<string, string> = {
  active: styles.rdActive, research: styles.rdResearch, proposed: styles.rdProposed,
};

const PRODUCT_TABS = [
  { id:'pro',         label:'LILA Pro' },
  { id:'mini',        label:'LILA Mini' },
  { id:'mega',        label:'LILA Mega' },
  { id:'makelila',    label:'makeLILA' },
  { id:'lovely',      label:'Lovely App' },
  { id:'shop',        label:'LILA Shop' },
  { id:'marketplace', label:'LILA Marketplace' },
  { id:'rd',          label:'Technical R&D' },
];

const VIEWS = ['Overview','PRD','User Journey','PMF','Issues','Timeline','Volumes','BOM','Team'] as const;
type View = typeof VIEWS[number];

/* ── Stage tracker ────────────────────────────────────────────────────────── */
function StageTracker({ stages, states }: { stages: StageItem[]; states: Record<string,string> }) {
  return (
    <div className={styles.stageTracker}>
      {stages.map((s, i) => {
        const status = states[s.id] ?? 'future';
        const isLast = i === stages.length - 1;
        const dotCls = `${styles.stageDotCircle} ${
          status === 'done'    ? styles.done :
          status === 'active'  ? styles.active :
          status === 'blocked' ? styles.blocked :
          styles.future
        }`;
        const labelCls = `${styles.stageLabel} ${
          status === 'done'   ? styles.doneLabel :
          status === 'active' ? styles.activeLabel : ''
        }`;
        return (
          <div key={s.id} className={styles.stageItem}>
            <div className={styles.stageDot}>
              <div className={dotCls}>{s.id.slice(0,2)}</div>
              <div className={labelCls}>{s.label}</div>
            </div>
            {!isLast && (
              <div className={`${styles.stageConnector} ${
                status === 'done' || stages[i+1] && (states[stages[i+1].id] !== 'future') ? styles.connDone : ''
              }`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── Overview ─────────────────────────────────────────────────────────────── */
function OverviewTab({ prod, d }: { prod: string; d: Product }) {
  const issueCount = d.issues.length;
  const critCount  = d.issues.filter(i => i.sev === 'critical').length;
  const teamPrimary = d.team.filter(m => m.type === 'primary');

  return (
    <div className={styles.ovProWrap}>
      <div className={styles.ovStatsRow}>
        {/* Card 1: product-specific primary stat */}
        {prod === 'pro' && (
          <div className={styles.ovCard}>
            <div className={styles.ovCardHead}>Current Batch</div>
            <div className={styles.ovCardVal}>P100X</div>
            <div className={styles.ovCardSub}>100 units · in-production at MicroArt Markham · ETA Oct 2026</div>
          </div>
        )}
        {prod === 'mini' && (
          <div className={styles.ovCard}>
            <div className={styles.ovCardHead}>Current Stage</div>
            <div className={`${styles.ovCardVal} ${styles.ovCardValAccent}`}>EVT</div>
            <div className={styles.ovCardSub}>Eng. Validation · Jul 2026 · Motor-gearbox integration in progress</div>
          </div>
        )}
        {prod === 'mega' && (
          <div className={styles.ovCard}>
            <div className={styles.ovCardHead}>Current Stage</div>
            <div className={`${styles.ovCardVal} ${styles.ovCardValOk}`}>EP</div>
            <div className={styles.ovCardSub}>Eng. Prototype · Q3 2026 · HKPC partnership active</div>
          </div>
        )}
        {prod === 'makelila' && (
          <div className={styles.ovCard}>
            <div className={styles.ovCardHead}>Version</div>
            <div className={`${styles.ovCardVal} ${styles.ovCardValAccent}`}>Alpha</div>
            <div className={styles.ovCardSub}>v0.1.0-infra shipped · live at lila.vip</div>
          </div>
        )}
        {prod === 'lovely' && (
          <div className={styles.ovCard}>
            <div className={styles.ovCardHead}>Stage</div>
            <div className={`${styles.ovCardVal} ${styles.ovCardValAccent}`}>Beta</div>
            <div className={styles.ovCardSub}>Live at beta-lovely · Next.js 16 PWA · iOS + Android</div>
          </div>
        )}
        {prod === 'shop' && (
          <div className={styles.ovCard}>
            <div className={styles.ovCardHead}>Weekly Run Rate</div>
            <div className={styles.ovCardVal}>~16</div>
            <div className={styles.ovCardSub}>units / week · target 100 units/mo in H2 2026</div>
          </div>
        )}
        {prod === 'marketplace' && (
          <div className={styles.ovCard}>
            <div className={styles.ovCardHead}>Tier-1 Vendors</div>
            <div className={styles.ovCardVal}>26</div>
            <div className={styles.ovCardSub}>Canadian Shopify brands identified · Phase 1 build in progress</div>
          </div>
        )}

        {/* Card 2: open issues */}
        <div className={styles.ovCard}>
          <div className={styles.ovCardHead}>Open Issues</div>
          <div className={`${styles.ovCardVal} ${issueCount > 0 ? styles.ovCardValCrit : ''}`}>
            {issueCount}
          </div>
          <div className={styles.ovCardSub}>
            {critCount > 0 ? `${critCount} critical` : 'no critical issues'}
            {issueCount > critCount && ` · ${issueCount - critCount} others`}
          </div>
        </div>

        {/* Card 3: team */}
        <div className={styles.ovCard}>
          <div className={styles.ovCardHead}>Team</div>
          <div className={styles.ovCardVal}>{d.team.length}</div>
          <div className={styles.ovCardAvatars}>
            {teamPrimary.slice(0, 6).map(m => (
              <div key={m.id} className={styles.ovAvatar} title={m.name}>{m.initials}</div>
            ))}
          </div>
        </div>
      </div>

      {d.notes.length > 0 && (
        <div className={styles.ovNotes}>
          <div className={styles.ovNotesTitle}>Status Notes</div>
          {d.notes.map((n, i) => (
            <div key={i} className={styles.ovNoteItem}>
              <span className={styles.ovNoteKey}>{n.label}</span>
              <span className={styles.ovNoteVal}>{n.val}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Issues ───────────────────────────────────────────────────────────────── */
function IssuesTab({ d }: { d: Product }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  if (!d.issues.length) return <div className={styles.empty}>No open issues.</div>;
  return (
    <div className={styles.issueList}>
      {d.issues.map((issue, i) => {
        const isOpen = expanded.has(i);
        return (
          <div
            key={i}
            className={`${styles.issueRow} ${isOpen ? styles.expanded : ''}`}
            onClick={() => setExpanded(prev => {
              const next = new Set(prev);
              next.has(i) ? next.delete(i) : next.add(i);
              return next;
            })}
          >
            <div className={styles.issueHeader}>
              <div className={`${styles.issueSev} ${SEV_CLASS[issue.sev] ?? ''}`}>
                {SEV_LABEL[issue.sev]}
              </div>
              <div style={{ flex: 1 }}>
                <div className={styles.issueTitle}>{issue.title}</div>
                <div className={styles.issueMeta}>
                  <span className={styles.issueTag}>{issue.tag}</span>
                  {issue.team && <span className={styles.issueTeam}>{issue.team}</span>}
                  {issue.mpBlocker && <span className={styles.mpBlocker}>MP Blocker</span>}
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--ink-4)', flexShrink: 0 }}>{isOpen ? '▲' : '▼'}</div>
            </div>
            {isOpen && <div className={styles.issueBody}>{issue.meta}</div>}
          </div>
        );
      })}
    </div>
  );
}

/* ── Timeline ─────────────────────────────────────────────────────────────── */
function TimelineTab({ d }: { d: Product }) {
  if (!d.timeline.length) return <div className={styles.empty}>No timeline data.</div>;
  return (
    <div className={styles.timelineList}>
      {d.timeline.map((t, i) => {
        const isLast = i === d.timeline.length - 1;
        const dotCls = `${styles.tlDot} ${
          t.status === 'done'    ? styles.done :
          t.status === 'active'  ? styles.active :
          t.status === 'blocked' ? styles.blocked :
          styles.future
        }`;
        return (
          <div key={t.id} className={styles.timelineItem}>
            <div className={styles.tlLine}>
              <div className={dotCls} />
              {!isLast && <div className={styles.tlConnector} />}
            </div>
            <div className={styles.tlBody}>
              <div className={styles.tlLabel}>{t.label}</div>
              <div className={styles.tlDate}>{t.date}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Volumes ──────────────────────────────────────────────────────────────── */
function ProVolumeChart() {
  const BARS = [
    { label:"May '26", n:100,  g:'26', milestone:'P100X · in prod' },
    { label:"Jun '26", n:100,  g:'26', milestone: null },
    { label:"Aug '26", n:300,  g:'26', milestone: null },
    { label:"Sep '26", n:500,  g:'26', milestone: null },
    { label:"Oct '26", n:600,  g:'26', milestone: null },
    { label:"Nov '26", n:700,  g:'26', milestone: null },
    { label:"Dec '26", n:749,  g:'26', milestone:'FM v13 ✓' },
    { label:"Q1 '27",  n:1100, g:'27', milestone: null },
    { label:"Q2 '27",  n:1400, g:'27', milestone:'Raise window' },
    { label:"Q3 '27",  n:1500, g:'27', milestone: null },
    { label:"Q4 '27",  n:1492, g:'27', milestone: null },
  ];
  const W = 700, H = 200, PAD = { t: 20, r: 20, b: 50, l: 50 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const maxN = 1600;
  const bw = innerW / BARS.length;
  const col26 = '#CC2D30', col27 = '#C17F5E';

  return (
    <div className={styles.proVolumeChart}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        {/* Grid lines */}
        {[400, 800, 1200, 1600].map(v => {
          const y = PAD.t + innerH - (v / maxN) * innerH;
          return (
            <g key={v}>
              <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke="#E8E0D4" strokeWidth="1" />
              <text x={PAD.l - 4} y={y + 4} textAnchor="end" fontSize="9" fill="#A39B8F">{v}</text>
            </g>
          );
        })}
        {/* Bars */}
        {BARS.map((b, i) => {
          const barH = (b.n / maxN) * innerH;
          const x = PAD.l + i * bw + 4;
          const y = PAD.t + innerH - barH;
          const fill = b.g === '26' ? col26 : col27;
          const labelY = PAD.t + innerH + 14;
          return (
            <g key={i}>
              <rect x={x} y={y} width={bw - 8} height={barH} fill={fill} fillOpacity="0.85" rx="2" />
              {b.n > 100 && (
                <text x={x + (bw - 8) / 2} y={y - 3} textAnchor="middle" fontSize="8" fill="#5C564E">{b.n}</text>
              )}
              {b.milestone && (
                <text x={x + (bw - 8) / 2} y={y - 12} textAnchor="middle" fontSize="7.5" fill={col26}>▲ {b.milestone}</text>
              )}
              <text x={x + (bw - 8) / 2} y={labelY} textAnchor="middle" fontSize="8" fill="#A39B8F">{b.label}</text>
            </g>
          );
        })}
        {/* Axes */}
        <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={PAD.t + innerH} stroke="#E8E0D4" strokeWidth="1.5" />
        <line x1={PAD.l} y1={PAD.t + innerH} x2={W - PAD.r} y2={PAD.t + innerH} stroke="#E8E0D4" strokeWidth="1.5" />
      </svg>
      <div className={styles.proVolumeTiles}>
        <div className={styles.proVolumeTile}>
          <div className={styles.proVolumeTileVal}>177</div>
          <div className={styles.proVolumeTileLabel}>Units shipped (DVT+PVT)</div>
        </div>
        <div className={styles.proVolumeTile}>
          <div className={styles.proVolumeTileVal}>9,241</div>
          <div className={styles.proVolumeTileLabel}>2028 est. (fin. model v13)</div>
        </div>
        <div className={styles.proVolumeTile}>
          <div className={styles.proVolumeTileVal}>14,433</div>
          <div className={styles.proVolumeTileLabel}>2029 est. (fin. model v13)</div>
        </div>
      </div>
    </div>
  );
}

function VolumesTab({ prod, d }: { prod: string; d: Product }) {
  if (!d.volumes.length) return <div className={styles.empty}>No volume data yet.</div>;
  return (
    <div>
      <table className={styles.volumeTable}>
        <thead>
          <tr>
            <th>Stage</th>
            <th>Count</th>
            <th>Type</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {d.volumes.map((v, i) => (
            <tr key={i}>
              <td style={{ fontWeight: 600 }}>{v.label ?? v.stage}</td>
              <td style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>
                {v.count != null ? v.count.toLocaleString() : '—'}
              </td>
              <td>
                <span className={`${styles.volBadge} ${
                  v.type === 'actual' ? styles.volActual :
                  v.type === 'planned' ? styles.volPlanned : styles.volTbd
                }`}>{v.type}</span>
              </td>
              <td>{v.sub ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {prod === 'pro' && (
        <div className={styles.proVolumeSection}>
          <div className={styles.sectionHead} style={{ marginTop: 20 }}>Production Ramp Forecast</div>
          <ProVolumeChart />
        </div>
      )}
    </div>
  );
}

/* ── BOM ──────────────────────────────────────────────────────────────────── */
function BOMTab({ d }: { d: Product }) {
  const [search, setSearch] = useState('');
  const [openGroups, setOpenGroups] = useState<Set<number>>(new Set([0]));
  const bom = d.bom;

  if (Array.isArray(bom) && bom.length === 0) {
    return <div className={styles.empty}>No BOM data yet.</div>;
  }

  if (isProBom(bom)) {
    const q = search.toLowerCase();
    return (
      <div>
        <div className={styles.bomHeader}>
          <div className={styles.bomPartNo}>{(bom as ProBom).partNo}</div>
          <div className={styles.bomMeta}>
            Rev {(bom as ProBom).version} · {(bom as ProBom).date} · {(bom as ProBom).supplier}
          </div>
        </div>
        <input
          className={styles.bomSearch}
          placeholder="Search by P/N, name, or spec…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {(bom as ProBom).groups.map((group, gi) => {
          const filtered = q
            ? group.items.filter(it =>
                it.pn.toLowerCase().includes(q) ||
                it.name.toLowerCase().includes(q) ||
                (it.spec ?? '').toLowerCase().includes(q)
              )
            : group.items;
          if (q && !filtered.length) return null;
          const isOpen = q ? true : openGroups.has(gi);
          return (
            <div key={gi} className={styles.bomGroup}>
              <button
                className={styles.bomGroupHead}
                onClick={() => setOpenGroups(prev => {
                  const next = new Set(prev);
                  next.has(gi) ? next.delete(gi) : next.add(gi);
                  return next;
                })}
              >
                <div className={styles.bomGroupName}>
                  <span className={styles.bomGroupIcon}>{group.icon}</span>
                  {group.name}
                  <span className={styles.bomGroupSup}>{group.supplier}</span>
                </div>
                <span className={styles.bomGroupCount}>
                  {filtered.length} item{filtered.length !== 1 ? 's' : ''}
                  <span className={`${styles.bomGroupChev} ${isOpen ? styles.open : ''}`}> ▾</span>
                </span>
              </button>
              {isOpen && (
                <div className={styles.bomItems}>
                  <div className={styles.bomRowHead}>
                    <span>P/N</span><span>Name / Spec</span>
                    <span>Qty</span><span>Unit</span><span></span>
                  </div>
                  {filtered.map((item, ii) => (
                    <div key={ii} className={styles.bomRow}>
                      <span className={styles.bomPn}>{item.pn}</span>
                      <span>
                        <div>{item.name}</div>
                        {item.spec && <div className={styles.bomSpec}>{item.spec}</div>}
                      </span>
                      <span>{item.qty}</span>
                      <span>{item.unit}</span>
                      <span />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  /* Flat BOM */
  const flatItems = bom as BomItem[];
  const q = search.toLowerCase();
  const filtered = q
    ? flatItems.filter(it => it.name.toLowerCase().includes(q) || it.pn.toLowerCase().includes(q))
    : flatItems;
  return (
    <div>
      <input
        className={styles.bomSearch}
        placeholder="Search BOM…"
        value={search}
        onChange={e => setSearch(e.target.value)}
      />
      <table className={styles.bomFlatTable}>
        <thead>
          <tr><th>P/N</th><th>Name</th><th>Qty</th><th>Unit</th><th>Cost</th></tr>
        </thead>
        <tbody>
          {filtered.map((item, i) => (
            <tr key={i}>
              <td><span className={styles.bomPn}>{item.pn}</span></td>
              <td>{item.name}</td>
              <td>{item.qty}</td>
              <td>{item.unit}</td>
              <td>{item.cost ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Team ─────────────────────────────────────────────────────────────────── */
function TeamTab({ d }: { d: Product }) {
  if (!d.team.length) return <div className={styles.empty}>No team data.</div>;
  return (
    <div className={styles.teamGrid}>
      {d.team.map(m => (
        <div key={m.id} className={`${styles.teamCard} ${m.type === 'supporting' ? styles.supporting : ''}`}>
          <div className={styles.teamCardHead}>
            <div className={`${styles.teamAvatar} ${m.type === 'supporting' ? styles.sup : ''}`}>
              {m.initials}
            </div>
            <div>
              <div className={styles.teamName}>{m.name}</div>
              <div className={styles.teamRole}>{m.role}</div>
            </div>
          </div>
          <div className={styles.teamDesc}>{m.desc}</div>
        </div>
      ))}
    </div>
  );
}

/* ── PRD ──────────────────────────────────────────────────────────────────── */
function PRDTab({ d }: { d: Product }) {
  if (!d.prd) return <div className={styles.empty}>No PRD data.</div>;
  const prd = d.prd;
  return (
    <div className={styles.prdWrap}>
      <div className={styles.prdVersion}>{prd.version} · Updated {prd.updated}</div>
      {prd.docRef && (
        <div className={styles.prdVersion} style={{ color: 'var(--ink-4)' }}>Ref: {prd.docRef}</div>
      )}
      {[
        { title:'Summary',         body: prd.summary },
        { title:'Problem',         body: prd.problem },
        { title:'Target Market',   body: prd.targetMarket },
        { title:'Goal / Gate',     body: prd.goalLine },
        { title:'MP Requirements', body: prd.mpRequirements },
      ].map(card => (
        <div key={card.title} className={styles.prdCard}>
          <div className={styles.prdCardTitle}>{card.title}</div>
          <div className={styles.prdCardBody}>{card.body}</div>
        </div>
      ))}
      {prd.keySpecs && prd.keySpecs.length > 0 && (
        <div className={styles.prdCard}>
          <div className={styles.prdCardTitle}>Key Specs</div>
          <ul className={styles.prdSpecs}>
            {prd.keySpecs.map((s, i) => <li key={i} className={styles.prdSpec}>{s}</li>)}
          </ul>
        </div>
      )}
      {prd.icp && prd.icp.length > 0 && (
        <div>
          <div className={styles.sectionHead}>Ideal Customer Profile</div>
          <div className={styles.icpGrid}>
            {prd.icp.map((icp, i) => (
              <div key={i} className={styles.icpCard}>
                <div className={styles.icpTier}>{icp.tier}</div>
                <div className={styles.icpPersona}>{icp.persona}</div>
                <div className={styles.icpProfile}>{icp.profile}</div>
                {[
                  { head:'Demographics',   items: icp.demographics },
                  { head:'Psychographics', items: icp.psychographics },
                  { head:'Triggers',       items: icp.triggers },
                  { head:'Barriers',       items: icp.barriers },
                ].map(group => (
                  <div key={group.head}>
                    <div className={styles.icpListHead}>{group.head}</div>
                    <div className={styles.icpListItems}>
                      {group.items.map((item, j) => <div key={j}>· {item}</div>)}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Journey ──────────────────────────────────────────────────────────────── */
function JourneyTab({ d }: { d: Product }) {
  if (!d.journey || !d.journey.length) return <div className={styles.empty}>No journey data.</div>;
  return (
    <div className={styles.journeyWrap}>
      {d.journey.map((step, i) => (
        <div key={i} className={styles.journeyStep}>
          <div className={styles.journeyStageCell}>
            <div className={styles.journeyStageLabel}>{step.stage}</div>
            {step.sub && <div className={styles.journeySub} style={{ fontSize: 11, color: 'var(--ink-3)', fontWeight: 400 }}>{step.sub}</div>}
            <div className={styles.journeyEmotion}>{step.emotion}</div>
          </div>
          <div className={styles.journeyBody}>
            {step.sub && <div className={styles.journeySub}>{step.sub}</div>}
            {step.touchpoints && (
              <div className={styles.journeyTouchpoints}>
                {step.touchpoints.map((tp, j) => <div key={j} className={styles.journeyTp}>{tp}</div>)}
              </div>
            )}
            {step.jtbd && <div className={styles.journeyJtbd}>"{step.jtbd}"</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── PMF ──────────────────────────────────────────────────────────────────── */
function PMFTab({ d }: { d: Product }) {
  if (!d.pmf) return <div className={styles.empty}>No PMF data.</div>;
  const pmf = d.pmf;
  const statusCls =
    pmf.status === 'ok'    ? styles.pmfStatusOk :
    pmf.status === 'warn'  ? styles.pmfStatusWarn :
    pmf.status === 'crit'  ? styles.pmfStatusCrit :
    styles.pmfStatusEarly;
  return (
    <div>
      <div className={statusCls}>{pmf.statusLabel} · {pmf.updated}</div>
      <div className={styles.pmfSummary}>{pmf.summary}</div>
      <div className={styles.pmfDimensions}>
        {pmf.dimensions.map(dim => (
          <div key={dim.id} className={styles.pmfDim}>
            <div className={styles.pmfDimLabel}>{dim.label}</div>
            <div className={styles.pmfDimQuestion}>{dim.question}</div>
            <div className={styles.pmfMetrics}>
              {dim.metrics.map((m, i) => (
                <div key={i} className={styles.pmfMetricRow}>
                  <div className={styles.pmfMetricLabel}>{m.label}</div>
                  <div className={styles.pmfMetricVal}>{m.val}</div>
                  <div className={styles.pmfMetricTarget}>{m.target}</div>
                  <div>
                    <span className={`${styles.pmfMetricPill} ${PMF_CLS[m.status] ?? ''}`}>
                      {m.status.toUpperCase()}
                    </span>
                  </div>
                  <div className={styles.pmfMetricNote}>{m.note}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── R&D tab ──────────────────────────────────────────────────────────────── */
function RDView() {
  return (
    <div className={styles.productPage}>
      <div className={styles.sectionHead}>Technical R&D Projects</div>
      <div className={styles.sectionSub}>
        Active research and development initiatives across firmware, hardware, and biology.
      </div>
      <div className={styles.rdGrid}>
        {RD_PROJECTS.map((proj, i) => (
          <div key={i} className={styles.rdCard}>
            <div className={styles.rdCardHead}>
              <div className={styles.rdCardTitle}>{proj.title}</div>
              <span className={`${styles.rdStatus} ${RD_STATUS_CLS[proj.status] ?? ''}`}>
                {proj.status}
              </span>
            </div>
            <div className={styles.rdDesc}>{proj.desc}</div>
            <div className={styles.rdFooter}>
              <div className={styles.rdLead}>
                <div className={styles.rdLeadInit}>{proj.lead}</div>
                <span>{proj.leadName}</span>
              </div>
              <span className={styles.rdTag}>{proj.tag}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Product page ─────────────────────────────────────────────────────────── */
function ProductPage({ prod, view, onViewChange }: {
  prod: string;
  view: View;
  onViewChange: (v: View) => void;
}) {
  const d = PRODUCTS[prod];
  if (!d) return null;
  const stages = d.customStages ?? STAGES;

  return (
    <div className={styles.productPage}>
      <StageTracker stages={stages} states={d.stageStates} />

      <div className={styles.kpiStrip}>
        {d.kpis.map((kpi, i) => (
          <div key={i} className={styles.kpiCard}>
            <div className={styles.kpiLabel}>{kpi.label}</div>
            <div className={`${styles.kpiVal} ${kpi.cls === 'v-crit' ? styles.vCrit : kpi.cls === 'v-med' ? styles.vMed : kpi.cls === 'v-success' ? styles.vSuccess : ''}`}>
              {kpi.val}
            </div>
            <div className={styles.kpiSub}>{kpi.sub}</div>
          </div>
        ))}
      </div>

      <div className={styles.viewChips}>
        {VIEWS.map(v => (
          <button
            key={v}
            className={`${styles.viewChip} ${view === v ? styles.activeChip : ''}`}
            onClick={() => onViewChange(v)}
          >{v}</button>
        ))}
      </div>

      {view === 'Overview'     && <OverviewTab prod={prod} d={d} />}
      {view === 'PRD'          && <PRDTab d={d} />}
      {view === 'User Journey' && <JourneyTab d={d} />}
      {view === 'PMF'          && <PMFTab d={d} />}
      {view === 'Issues'       && <IssuesTab d={d} />}
      {view === 'Timeline'     && <TimelineTab d={d} />}
      {view === 'Volumes'      && <VolumesTab prod={prod} d={d} />}
      {view === 'BOM'          && <BOMTab d={d} />}
      {view === 'Team'         && <TeamTab d={d} />}
    </div>
  );
}

/* ── Root ─────────────────────────────────────────────────────────────────── */
export default function Products() {
  const [activeProd, setActiveProd] = useState('pro');
  const [activeViews, setActiveViews] = useState<Record<string, View>>({
    pro:'Overview', mini:'Overview', mega:'Overview', makelila:'Overview',
    lovely:'Overview', shop:'Overview', marketplace:'Overview',
  });

  const setView = (v: View) =>
    setActiveViews(prev => ({ ...prev, [activeProd]: v }));

  return (
    <div className={styles.products}>
      <div className={styles.tabBar}>
        {PRODUCT_TABS.map(tab => {
          const d = PRODUCTS[tab.id];
          return (
            <button
              key={tab.id}
              className={`${styles.prodTab} ${activeProd === tab.id ? styles.active : ''}`}
              onClick={() => setActiveProd(tab.id)}
            >
              {tab.label}
              {d?.badgeCount && (
                <span className={`${styles.badge} ${
                  d.badgeClass === 'badge-crit' ? styles.badgeCrit :
                  d.badgeClass === 'badge-high' ? styles.badgeHigh :
                  d.badgeClass === 'badge-ok'   ? styles.badgeOk :
                  styles.badgeAcc
                }`}>{d.badgeCount}</span>
              )}
              {tab.id === 'rd' && (
                <span className={`${styles.badge} ${styles.badgeAcc}`}>
                  {RD_PROJECTS.filter(p => p.status === 'active').length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {activeProd === 'rd' ? (
        <RDView />
      ) : (
        <ProductPage
          prod={activeProd}
          view={activeViews[activeProd] ?? 'Overview'}
          onViewChange={setView}
        />
      )}
    </div>
  );
}
