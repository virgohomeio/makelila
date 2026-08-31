import { useMemo, useState } from 'react';
import {
  useCustomerProfitability, useProfitabilityRates, useAcquisitionSpend,
  useRetainedUnitCosts,
  type CustomerProfitability,
} from '../../lib/customers';
import {
  allocateCac, byChannel, byCohort, byCountry, byRegion, byVolume,
  channelLabel, customerMetrics, isUnpriced, portfolio, profitDistribution,
  reliability, retainedUnits, waterfall, CHANNEL_LABELS, VOLUME_LABELS,
  UNAVAILABLE_METRICS, costsBasis, marginBasis, BASIS_LABEL,
  type CustomerMetrics, type PortfolioMetrics, type BucketBasis,
  type RetainedUnits,
} from '../../lib/profitability';
import { regionName } from '../../lib/regions';
import { formatMoney } from '../../lib/money';
import { GeoMap, type GeoMeasure } from './profitability/GeoMap';
import {
  CohortProfitChart, LtvCacScatter, ProfitDistribution, WaterfallChart,
} from './profitability/Charts';
import { SegmentTable } from './profitability/SegmentTable';
import { CustomerDetail } from './profitability/CustomerDetail';
import styles from './Customers.module.css';

type SortKey =
  | 'profit_desc' | 'profit_asc' | 'margin_desc' | 'margin_asc'
  | 'warranty_desc' | 'revenue_desc' | 'support_desc' | 'cac_desc';
type CountryFilter = 'all' | 'CA' | 'US' | 'other';
type ViewKey = 'overview' | 'geography' | 'segments' | 'cohorts' | 'customers';

const VIEWS: { key: ViewKey; label: string }[] = [
  { key: 'overview',   label: 'Overview' },
  { key: 'geography',  label: 'Geography' },
  { key: 'segments',   label: 'Channels & segments' },
  { key: 'cohorts',    label: 'Cohorts' },
  { key: 'customers',  label: 'Customers' },
];

export function ProfitabilityTab() {
  const { rows, loading, error } = useCustomerProfitability();
  const { rates } = useProfitabilityRates();
  const { spend } = useAcquisitionSpend();
  const { rows: retainedRows } = useRetainedUnitCosts();

  const [view, setView] = useState<ViewKey>('overview');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('profit_desc');
  const [country, setCountry] = useState<CountryFilter>('all');
  const [region, setRegion] = useState<string>('all');
  const [channel, setChannel] = useState<string>('all');
  const [volume, setVolume] = useState<string>('all');
  // Backlog #58 V2 — onboard-date cohort filter. Lets operators isolate
  // a specific month's batch when a warranty spike correlates with a
  // hardware revision or shipping carrier change.
  const [cohort, setCohort] = useState<string>('all');
  const [cohortGrain, setCohortGrain] = useState<'month' | 'quarter'>('month');
  const [geoMeasure, setGeoMeasure] = useState<GeoMeasure>('profitPerCustomer');
  // Default-hide team accounts (Pedrum etc.) so they don't skew the view.
  const [showTeam, setShowTeam] = useState(false);
  const [hideZero, setHideZero] = useState(true);
  const [openCustomer, setOpenCustomer] = useState<string | null>(null);

  // CAC is allocated once over every customer, before any filter narrows the
  // set. Allocating inside the filter would make one customer's CAC change
  // depending on who else is on screen.
  const cacResult = useMemo(() => allocateCac(rows, spend), [rows, spend]);

  const allMetrics = useMemo(
    () => new Map(rows.map(r => [r.id, customerMetrics(r, cacResult.byCustomer.get(r.id), rates)])),
    [rows, cacResult, rates],
  );

  const cohortOptions = useMemo(() => buildCohortOptions(rows), [rows]);
  const regionOptions = useMemo(() => buildRegionOptions(rows), [rows]);

  // Every filter except the region one. The map, the region rankings and the
  // province/state table are all built from this rather than from
  // filteredRows: a filter control has to keep showing the options it is
  // choosing between. Narrowing geography by the geography filter left one
  // region on the map and hatched the other sixty-three, so clicking Arizona
  // made the map claim Texas had no customers.
  const rowsBeforeRegion = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter(r => showTeam || !r.is_team_member)
      .filter(r => !hideZero || hasActivity(r))
      .filter(r => {
        if (country === 'all') return true;
        if (country === 'other') return r.country !== 'CA' && r.country !== 'US';
        return r.country === country;
      })
      .filter(r => channel === 'all' || r.acquisition_channel === channel)
      .filter(r => {
        if (volume === 'all') return true;
        const m = allMetrics.get(r.id);
        return m != null && volumeKey(m) === volume;
      })
      .filter(r => cohort === 'all' || cohortOf(r) === cohort)
      .filter(r => q === '' || r.full_name.toLowerCase().includes(q) || (r.email ?? '').toLowerCase().includes(q));
  }, [rows, search, country, channel, volume, cohort, showTeam, hideZero, allMetrics]);

  const filteredRows = useMemo(
    () => rowsBeforeRegion.filter(r => region === 'all' || r.region_code === region),
    [rowsBeforeRegion, region],
  );

  const filteredMetrics = useMemo(
    () => filteredRows.map(r => allMetrics.get(r.id)!).filter(Boolean),
    [filteredRows, allMetrics],
  );

  const sortedRows = useMemo(
    () => [...filteredRows].sort(sortFn(sort, allMetrics)),
    [filteredRows, sort, allMetrics],
  );

  const totals = useMemo(() => portfolio(filteredMetrics), [filteredMetrics]);
  const legacyTotals = useMemo(() => aggregate(filteredRows), [filteredRows]);
  const regions = useMemo(() => byRegion(filteredMetrics), [filteredMetrics]);
  // The geography dimension at full width — see rowsBeforeRegion.
  const geoRegions = useMemo(
    () => byRegion(rowsBeforeRegion.map(r => allMetrics.get(r.id)!).filter(Boolean)),
    [rowsBeforeRegion, allMetrics],
  );
  // Whether anything *other* than the region pick is narrowing the map, so a
  // hatched region can say which kind of empty it is. showTeam and hideZero
  // are deliberately absent: hideZero is on by default and showTeam is off,
  // and flipping either one only ever *adds* rows — neither is a narrowing
  // the operator chose.
  const geoNarrowed = country !== 'all' || channel !== 'all' || volume !== 'all'
    || cohort !== 'all' || search.trim() !== '';
  const channels = useMemo(() => byChannel(filteredMetrics), [filteredMetrics]);
  const countries = useMemo(() => byCountry(filteredMetrics), [filteredMetrics]);
  const volumes = useMemo(() => byVolume(filteredMetrics), [filteredMetrics]);
  const cohorts = useMemo(() => byCohort(filteredMetrics, cohortGrain), [filteredMetrics, cohortGrain]);
  const reliabilityStats = useMemo(() => reliability(filteredRows), [filteredRows]);
  // Company-level, so it never narrows with a filter: a cancelled order has no
  // customer to filter it by. Shown beside contribution margin, never inside.
  const retained = useMemo(() => retainedUnits(retainedRows), [retainedRows]);
  // Insights are computed from the *unfiltered* set (minus team accounts)
  // so the panel always shows the full picture regardless of search.
  const insights = useMemo(() => computeInsights(rows.filter(r => showTeam || !r.is_team_member)), [rows, showTeam]);

  const openRow = openCustomer ? rows.find(r => r.id === openCustomer) : undefined;

  if (loading) return <div className={styles.loading}>Loading profitability…</div>;
  if (error) return <div className={styles.error}>Failed to load: {error.message}</div>;

  const filtersActive = country !== 'all' || region !== 'all' || channel !== 'all'
                     || volume !== 'all' || cohort !== 'all' || search.trim() !== '';

  return (
    <div className={styles.profitabilityTab}>
      <nav className={styles.profViewNav} role="tablist" aria-label="Profitability views">
        {VIEWS.map(v => (
          <button
            key={v.key}
            role="tab"
            aria-selected={view === v.key}
            className={`${styles.profViewTab} ${view === v.key ? styles.profViewTabActive : ''}`}
            onClick={() => setView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </nav>

      <FilterBar
        search={search} setSearch={setSearch}
        country={country} setCountry={setCountry}
        region={region} setRegion={setRegion} regionOptions={regionOptions}
        channel={channel} setChannel={setChannel}
        volume={volume} setVolume={setVolume}
        cohort={cohort} setCohort={setCohort} cohortOptions={cohortOptions}
        showTeam={showTeam} setShowTeam={setShowTeam}
        hideZero={hideZero} setHideZero={setHideZero}
        sort={sort} setSort={setSort}
        showSort={view === 'customers'}
        filtersActive={filtersActive}
        onClear={() => {
          setSearch(''); setCountry('all'); setRegion('all');
          setChannel('all'); setVolume('all'); setCohort('all');
        }}
        matched={filteredRows.length}
      />

      {view === 'overview' && (
        <OverviewView
          totals={totals}
          metrics={filteredMetrics}
          channels={channels}
          regions={regions}
          cacResult={cacResult}
          reliabilityStats={reliabilityStats}
          rates={ratesSummary(rates)}
          insights={insights}
          retained={retained}
        />
      )}

      {view === 'geography' && (
        <GeographyView
          regions={geoRegions}
          narrowed={geoNarrowed}
          countries={countries}
          measure={geoMeasure}
          setMeasure={setGeoMeasure}
          selected={region === 'all' ? null : region}
          onSelect={code => setRegion(code ?? 'all')}
        />
      )}

      {view === 'segments' && (
        <SegmentsView
          channels={channels}
          volumes={volumes}
          countries={countries}
          onSelectChannel={key => setChannel(channel === key ? 'all' : key)}
          selectedChannel={channel === 'all' ? null : channel}
        />
      )}

      {view === 'cohorts' && (
        <CohortsView
          cohorts={cohorts}
          grain={cohortGrain}
          setGrain={setCohortGrain}
          onSelect={key => setCohort(cohort === key ? 'all' : key)}
          selected={cohort === 'all' ? null : cohort}
        />
      )}

      {view === 'customers' && (
        <CustomersView
          rows={sortedRows}
          metrics={allMetrics}
          totals={legacyTotals}
          onOpen={setOpenCustomer}
        />
      )}

      {openRow && allMetrics.get(openRow.id) && (
        <div className={styles.detailBackdrop} onClick={() => setOpenCustomer(null)}>
          <div onClick={e => e.stopPropagation()}>
            <CustomerDetail
              row={openRow}
              metrics={allMetrics.get(openRow.id)!}
              onClose={() => setOpenCustomer(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Filters ─────────────────────────────────────────────────────────────────

function FilterBar(p: {
  search: string; setSearch: (v: string) => void;
  country: CountryFilter; setCountry: (v: CountryFilter) => void;
  region: string; setRegion: (v: string) => void;
  regionOptions: { key: string; label: string; count: number }[];
  channel: string; setChannel: (v: string) => void;
  volume: string; setVolume: (v: string) => void;
  cohort: string; setCohort: (v: string) => void;
  cohortOptions: { key: string; label: string; count: number }[];
  showTeam: boolean; setShowTeam: (v: boolean) => void;
  hideZero: boolean; setHideZero: (v: boolean) => void;
  sort: SortKey; setSort: (v: SortKey) => void;
  showSort: boolean;
  filtersActive: boolean;
  onClear: () => void;
  matched: number;
}) {
  return (
    <div className={styles.profControls}>
      <input
        className={styles.profSearch}
        placeholder="Search customer…"
        value={p.search}
        onChange={e => p.setSearch(e.target.value)}
      />
      {p.showSort && (
        <select value={p.sort} onChange={e => p.setSort(e.target.value as SortKey)} aria-label="Sort">
          <option value="profit_desc">Most profitable</option>
          <option value="profit_asc">Losing money first</option>
          <option value="margin_desc">Highest contribution</option>
          <option value="margin_asc">Lowest contribution</option>
          <option value="warranty_desc">Highest expected warranty</option>
          <option value="revenue_desc">Highest revenue</option>
          <option value="support_desc">Most support time</option>
          <option value="cac_desc">Highest CAC</option>
        </select>
      )}
      <select value={p.country} onChange={e => p.setCountry(e.target.value as CountryFilter)} aria-label="Country">
        <option value="all">All countries</option>
        <option value="CA">CA</option>
        <option value="US">US</option>
        <option value="other">Other</option>
      </select>
      <select value={p.region} onChange={e => p.setRegion(e.target.value)} aria-label="Province or state">
        <option value="all">All provinces / states</option>
        {p.regionOptions.map(r => (
          <option key={r.key} value={r.key}>{r.label} ({r.count})</option>
        ))}
      </select>
      <select value={p.channel} onChange={e => p.setChannel(e.target.value)} aria-label="Acquisition channel">
        <option value="all">All channels</option>
        {Object.keys(CHANNEL_LABELS).map(k => (
          <option key={k} value={k}>{CHANNEL_LABELS[k]}</option>
        ))}
      </select>
      <select value={p.volume} onChange={e => p.setVolume(e.target.value)} aria-label="Units purchased">
        <option value="all">Any number of units</option>
        {Object.keys(VOLUME_LABELS).map(k => (
          <option key={k} value={k}>{VOLUME_LABELS[k]}</option>
        ))}
      </select>
      <select value={p.cohort} onChange={e => p.setCohort(e.target.value)} title="Filter by acquisition cohort">
        <option value="all">All cohorts</option>
        {p.cohortOptions.map(c => (
          <option key={c.key} value={c.key}>{c.label} ({c.count})</option>
        ))}
      </select>
      <label className={styles.profToggle}>
        <input type="checkbox" checked={p.hideZero} onChange={e => p.setHideZero(e.target.checked)} />
        <span>Hide zero-activity</span>
      </label>
      <label className={styles.profToggle}>
        <input type="checkbox" checked={p.showTeam} onChange={e => p.setShowTeam(e.target.checked)} />
        <span>Show team accounts</span>
      </label>
      {p.filtersActive && (
        <button className={styles.profClearBtn} onClick={p.onClear}>
          Clear filters ({p.matched} shown)
        </button>
      )}
    </div>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

function OverviewView({
  totals, metrics, channels, regions, cacResult, reliabilityStats, rates, insights,
  retained,
}: {
  totals: PortfolioMetrics;
  metrics: CustomerMetrics[];
  channels: ReturnType<typeof byChannel>;
  regions: ReturnType<typeof byRegion>;
  cacResult: ReturnType<typeof allocateCac>;
  reliabilityStats: ReturnType<typeof reliability>;
  rates: { unpricedBuckets: string[] };
  insights: Insights;
  retained: RetainedUnits;
}) {
  const best = regions.filter(r => r.customers >= 3)[0];
  const worst = [...regions].filter(r => r.customers >= 3).pop();

  return (
    <>
      <div className={styles.kpiGrid}>
        <Kpi label="Total customer revenue" value={fmt(totals.revenue)} />
        <Kpi label="Revenue per customer"
             value={totals.customers > 0 ? fmt(totals.revenue / totals.customers) : '—'} />
        <Kpi label="Contribution margin" value={fmt(totals.contributionMargin)}
             tone={totals.contributionMargin < 0 ? 'bad' : 'good'} est="partial"
             hint="Revenue less all eleven cost buckets. Some of those are rates rather than invoices — COGS is part projected, support, return handling and 3PL handling are rate-based, and three buckets are unpriced — so this is an upper bound on the loss, not a settled figure." />
        <Kpi label="Contribution margin %"
             value={totals.contributionMarginPct == null ? '—'
                    : `${(totals.contributionMarginPct * 100).toFixed(0)}%`}
             tone={(totals.contributionMarginPct ?? 0) < 0 ? 'bad' : 'good'} />
        <Kpi label="CAC" value={totals.cacTotal === 0 ? 'no spend on file' : fmt(totals.cac)}
             hint="Meta spend divided across the customers each campaign month won. Channels with no spend feed are booked at $0." />
        <Kpi label="LTV (realized)" value={fmt(totals.ltv)} est="partial"
             hint="Contribution margin banked to date, per customer. Not a projection — but it inherits the estimated buckets inside contribution margin." />
        <Kpi label="LTV:CAC"
             value={totals.ltvCac == null ? '—' : `${totals.ltvCac.toFixed(1)}×`}
             tone={totals.ltvCac == null ? undefined : totals.ltvCac >= 3 ? 'good' : 'warn'} />
        <Kpi label="CAC payback"
             value={`${totals.paybackImmediate} at sale · ${totals.paybackOutstanding} short`}
             hint="LILA sells once, so acquisition is either recovered by the sale or not at all until there is recurring revenue." />
        <Kpi label="Lifetime contribution profit" value={fmt(totals.lifetimeProfit)}
             tone={totals.lifetimeProfit < 0 ? 'bad' : 'good'} est="partial"
             hint="Contribution margin less CAC. Inherits every estimate inside the margin, and CAC itself is $0 for every customer until acquisition spend is loaded monthly." />
        <Kpi label="Warranty + service per unit"
             value={fmt(reliabilityStats.warrantyPlusServicePerUnit)}
             tone="warn" est="estimated"
             hint="Support labour and return handling are both rate-based, so this is an estimate." />
      </div>
      <EstimateLegend />
      <RetainedUnitsBand retained={retained} />

      <div className={styles.overviewSplit}>
        <WaterfallChart steps={waterfall(metrics, totals.cacTotal)} />
        <ProfitDistribution buckets={profitDistribution(metrics)} />
      </div>

      <div className={styles.overviewSplit}>
        <LtvCacScatter segments={channels} label="acquisition channel" />
        <div className={styles.chartFigure}>
          <div className={styles.chartTitle}>
            Best and worst regions
            <span className={styles.chartSub}>
              Provinces and states with at least 3 customers, by lifetime profit per customer.
            </span>
          </div>
          {best && worst && best.key !== worst.key ? (
            <div className={styles.bestWorst}>
              <div className={styles.bestWorstCard}>
                <span className={styles.bestWorstTag}>Most profitable</span>
                <strong>{regionName(best.key)}</strong>
                <span>{fmt(best.profitPerCustomer)} per customer · {best.customers} customers</span>
              </div>
              <div className={`${styles.bestWorstCard} ${styles.bestWorstBad}`}>
                <span className={styles.bestWorstTag}>Least profitable</span>
                <strong>{regionName(worst.key)}</strong>
                <span>{fmt(worst.profitPerCustomer)} per customer · {worst.customers} customers</span>
              </div>
            </div>
          ) : (
            <div className={styles.chartEmpty}>Not enough regions with 3+ customers to compare.</div>
          )}
        </div>
      </div>

      <InsightsPanel insights={insights} />

      <DataQualityPanel
        cacResult={cacResult}
        unpricedBuckets={rates.unpricedBuckets}
        reliabilityStats={reliabilityStats}
      />
    </>
  );
}

/** Cost that no customer carries.
 *
 *  LILA keeps the machine when an order is cancelled, so V16 takes its build
 *  cost off the customer — charging it to the person who cancelled would make
 *  them read as the worst sale in the book. Their revenue stays, and the refund
 *  reverses it once. The machine was still built, though, so the cost cannot
 *  vanish with the order: it is stated here, beside contribution margin and
 *  deliberately not inside it. */
function RetainedUnitsBand({ retained }: { retained: RetainedUnits }) {
  if (retained.orders === 0) return null;
  return (
    <div className={styles.retainedBand}>
      <span className={styles.retainedBandLabel}>
        Outside contribution margin · units retained from cancelled orders
      </span>
      <span className={styles.retainedBandValue}>
        {fmt(retained.total)}
        {retained.anyModelled && <Est basis="estimated" />}
      </span>
      <span className={styles.retainedBandNote}>
        {retained.units} machine{retained.units === 1 ? '' : 's'} across{' '}
        {retained.orders} cancelled order{retained.orders === 1 ? '' : 's'} —{' '}
        {fmt(retained.cogs)} build cost
        {retained.freight > 0 && (
          <> plus {fmt(retained.freight)} of freight on {retained.shippedBeforeCancel}{' '}
            that had already shipped</>
        )}
        . LILA kept the units, so no customer carries this — their revenue stays
        on their record and the refund reverses it there.
      </span>
    </div>
  );
}

function Kpi({ label, value, tone, hint, est }: {
  label: string; value: string; tone?: 'good' | 'bad' | 'warn'; hint?: string; est?: BucketBasis;
}) {
  const cls = tone === 'good' ? styles.profStatGood
            : tone === 'bad'  ? styles.profStatBad
            : tone === 'warn' ? styles.profStatWarn
            : '';
  return (
    <div className={`${styles.profStat} ${cls}`} title={hint}>
      <div className={styles.profStatLabel}>{label}{est && <Est basis={est} />}</div>
      <div className={styles.profStatValue}>{value}</div>
    </div>
  );
}

/** Everything the dashboard knows it cannot see. Kept on the overview rather
 *  than buried, because a metric that is quietly missing reads as a metric
 *  that was measured and came back fine. */
function DataQualityPanel({
  cacResult, unpricedBuckets, reliabilityStats,
}: {
  cacResult: ReturnType<typeof allocateCac>;
  unpricedBuckets: string[];
  reliabilityStats: ReturnType<typeof reliability>;
}) {
  return (
    <details className={styles.dataQuality}>
      <summary>What these numbers do and don't cover</summary>
      <div className={styles.dataQualityBody}>
        <section>
          <h5>Costs nobody has priced yet</h5>
          {unpricedBuckets.length === 0 ? (
            <p>Every cost bucket has a rate on file.</p>
          ) : (
            <p>
              {unpricedBuckets.join(', ')} are rated at $0 in <code>profitability_rates</code>.
              Contribution margin is an upper bound until they are set.
            </p>
          )}
        </section>
        <section>
          <h5>Acquisition spend</h5>
          <p>
            Meta campaign spend syncs from <code>fb_campaigns</code>. Every other channel
            needs rows in <code>acquisition_spend_manual</code> and is booked at $0 until
            it has them, so their CAC reads as zero and their LTV:CAC as undefined.
            {cacResult.unallocatedSpendCad > 0 && (
              <> {fmt(cacResult.unallocatedSpendCad)} of spend fell in months that won no
              customer, and is not carried by anyone.</>
            )}
          </p>
        </section>
        <section>
          <h5>Reliability</h5>
          <p>
            {reliabilityStats.unitsSold} units sold ·{' '}
            {pct(reliabilityStats.warrantyClaimRate)} of customers have had a replacement ·{' '}
            {fmt(reliabilityStats.warrantyCostPerUnit)} warranty cost per unit.
          </p>
        </section>
        <section>
          <h5>Metrics this database cannot answer</h5>
          <ul>
            {UNAVAILABLE_METRICS.map(u => (
              <li key={u.metric}><strong>{u.metric}</strong> — {u.reason}</li>
            ))}
          </ul>
        </section>
      </div>
    </details>
  );
}

// ── Geography ───────────────────────────────────────────────────────────────

function GeographyView({
  regions, narrowed, countries, measure, setMeasure, selected, onSelect,
}: {
  regions: ReturnType<typeof byRegion>;
  narrowed: boolean;
  countries: ReturnType<typeof byCountry>;
  measure: GeoMeasure;
  setMeasure: (m: GeoMeasure) => void;
  selected: string | null;
  onSelect: (code: string | null) => void;
}) {
  // A single customer's region tells you nothing about the region. Ranking
  // needs enough customers that one warranty claim cannot flip the order.
  const ranked = regions.filter(r => r.customers >= 3);

  return (
    <>
      <GeoMap
        regions={regions}
        narrowed={narrowed}
        measure={measure}
        onMeasureChange={setMeasure}
        onSelect={onSelect}
        selected={selected}
      />

      <div className={styles.overviewSplit}>
        <div className={styles.chartFigure}>
          <div className={styles.chartTitle}>
            Most profitable regions
            <span className={styles.chartSub}>3 or more customers, ranked by profit per customer.</span>
          </div>
          <RegionRank rows={[...ranked].sort(byProfitPerCustomer).slice(0, 6)} onSelect={onSelect} />
        </div>
        <div className={styles.chartFigure}>
          <div className={styles.chartTitle}>
            Least profitable regions
            <span className={styles.chartSub}>Same bar — these are where the money goes.</span>
          </div>
          <RegionRank rows={[...ranked].sort(byProfitPerCustomer).slice(-6).reverse()} onSelect={onSelect} />
        </div>
      </div>

      <h4 className={styles.sectionHeading}>Every province and state</h4>
      <SegmentTable
        segments={regions}
        dimensionLabel="Province / state"
        onSelect={key => onSelect(selected === key ? null : key)}
        selected={selected}
      />

      <h4 className={styles.sectionHeading}>By country</h4>
      <SegmentTable segments={countries} dimensionLabel="Country" />
    </>
  );
}

function byProfitPerCustomer(a: { profitPerCustomer: number | null }, b: { profitPerCustomer: number | null }) {
  return (b.profitPerCustomer ?? 0) - (a.profitPerCustomer ?? 0);
}

function RegionRank({ rows, onSelect }: {
  rows: ReturnType<typeof byRegion>;
  onSelect: (code: string) => void;
}) {
  if (rows.length === 0) return <div className={styles.chartEmpty}>Not enough data yet.</div>;
  const max = Math.max(...rows.map(r => Math.abs(r.profitPerCustomer ?? 0)), 1);
  return (
    <div className={styles.rankList}>
      {rows.map(r => {
        const v = r.profitPerCustomer ?? 0;
        return (
          <button key={r.key} className={styles.rankRow} onClick={() => onSelect(r.key)}>
            <span className={styles.rankName}>{regionName(r.key)}</span>
            <span className={styles.rankTrack}>
              <span
                className={styles.rankBar}
                style={{
                  width: `${(Math.abs(v) / max) * 100}%`,
                  background: v < 0 ? '#b93030' : '#2a78d6',
                }}
              />
            </span>
            <span className={styles.rankValue}>{fmt(v)}</span>
            <span className={styles.rankCount}>{r.customers}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Segments ────────────────────────────────────────────────────────────────

function SegmentsView({
  channels, volumes, countries, onSelectChannel, selectedChannel,
}: {
  channels: ReturnType<typeof byChannel>;
  volumes: ReturnType<typeof byVolume>;
  countries: ReturnType<typeof byCountry>;
  onSelectChannel: (key: string) => void;
  selectedChannel: string | null;
}) {
  return (
    <>
      <h4 className={styles.sectionHeading}>By acquisition channel</h4>
      <SegmentTable
        segments={channels}
        dimensionLabel="Channel"
        onSelect={onSelectChannel}
        selected={selectedChannel}
      />
      <LtvCacScatter segments={channels} label="acquisition channel" />

      <h4 className={styles.sectionHeading}>By units purchased</h4>
      <p className={styles.sectionNote}>
        LILA does not record whether a customer is residential or commercial. Units
        purchased is the closest observable proxy — a fleet buyer is almost always a
        business.
      </p>
      <SegmentTable segments={volumes} dimensionLabel="Segment" />

      <h4 className={styles.sectionHeading}>By country</h4>
      <SegmentTable segments={countries} dimensionLabel="Country" />
    </>
  );
}

// ── Cohorts ─────────────────────────────────────────────────────────────────

function CohortsView({
  cohorts, grain, setGrain, onSelect, selected,
}: {
  cohorts: ReturnType<typeof byCohort>;
  grain: 'month' | 'quarter';
  setGrain: (g: 'month' | 'quarter') => void;
  onSelect: (key: string) => void;
  selected: string | null;
}) {
  return (
    <>
      <div className={styles.cohortControls}>
        <span>Cohort grain</span>
        <button
          className={grain === 'month' ? styles.grainActive : styles.grainBtn}
          onClick={() => setGrain('month')}
        >Monthly</button>
        <button
          className={grain === 'quarter' ? styles.grainActive : styles.grainBtn}
          onClick={() => setGrain('quarter')}
        >Quarterly</button>
      </div>
      <p className={styles.sectionNote}>
        Cohorts are anchored on the first sale order, not the onboarding date — onboarding
        is entered by hand and often lands weeks after the customer actually bought.
      </p>
      <CohortProfitChart cohorts={cohorts.filter(c => c.key !== 'unknown')} />
      <SegmentTable
        segments={cohorts}
        dimensionLabel="Cohort"
        onSelect={onSelect}
        selected={selected}
      />
    </>
  );
}

// ── Customers ───────────────────────────────────────────────────────────────

function CustomersView({
  rows, metrics, totals, onOpen,
}: {
  rows: CustomerProfitability[];
  metrics: Map<string, CustomerMetrics>;
  totals: ReturnType<typeof aggregate>;
  onOpen: (id: string) => void;
}) {
  const [layout, setLayout] = useState<'table' | 'cards'>('table');

  return (
    <>
      <div className={styles.profSummary}>
        <SummaryStat label="Customers"            value={String(rows.length)} />
        <SummaryStat label="Revenue (net of tax)" value={fmt(totals.revenue)} />
        <SummaryStat label="Tax collected"        value={fmt(totals.tax)}       variant="warn" />
        <SummaryStat label="COGS + shipping"      value={fmt(totals.salesCost)} variant="warn" est="partial" />
        <SummaryStat label="Expected warranty"    value={fmt(totals.warranty)}  variant="warn" />
        <SummaryStat label="Expected refunds"     value={fmt(totals.refund)}    variant="warn" />
        <SummaryStat label="Return handling"      value={fmt(totals.returnHandling)} variant="warn" est="estimated" />
        <SummaryStat label="Support labour"
                     value={totals.supportPriced ? fmt(totals.support) : 'rate not set'}
                     variant="warn" est={totals.supportPriced ? 'estimated' : 'unpriced'} />
        <SummaryStat label="Consumables & parts"  value={fmt(totals.consumables)} variant="warn" />
        <SummaryStat label="3PL handling"          value={fmt(totals.fulfilment)} variant="warn" est="estimated" />
        <SummaryStat label="Net margin"           value={fmt(totals.margin)}    variant={totals.margin < 0 ? 'bad' : 'good'} />
      </div>
      <EstimateLegend />
      <div className={styles.profCurrencyNote}>
        Revenue excludes sales tax (passed through to govt, not VCycene income). "Expected warranty" sums COGS + shipping for every non-cancelled replacement order. "Expected refunds" sums every refund approval that isn't denied. "Support labour" prices diagnosis calls at time on the call × internal attendees × the blended person-hour rate in <code>support_rates</code>, including calls the customer never joined. "Return handling" is stocking + inspection + return freight for units that physically came back — units the customer discarded are excluded, and it is separate from the restocking fee charged to the customer. All amounts are converted to CAD through <code>fx_rates</code> — USD orders at the current company rate, not the rate on the order date.
      </div>

      <div className={styles.layoutToggle}>
        <button className={layout === 'table' ? styles.grainActive : styles.grainBtn}
                onClick={() => setLayout('table')}>Table</button>
        <button className={layout === 'cards' ? styles.grainActive : styles.grainBtn}
                onClick={() => setLayout('cards')}>Cards</button>
      </div>

      {rows.length === 0 ? (
        <div className={styles.empty}>No customers match these filters.</div>
      ) : layout === 'table' ? (
        <CustomerTable rows={rows} metrics={metrics} onOpen={onOpen} />
      ) : (
        <div className={styles.profGrid}>
          {rows.map(r => <ProfitCard key={r.id} row={r} onOpen={() => onOpen(r.id)} />)}
        </div>
      )}
    </>
  );
}

function CustomerTable({ rows, metrics, onOpen }: {
  rows: CustomerProfitability[];
  metrics: Map<string, CustomerMetrics>;
  onOpen: (id: string) => void;
}) {
  return (
    <div className={styles.segTableWrap}>
      <table className={styles.segTable}>
        <thead>
          <tr>
            <th>Customer</th>
            <th>Region</th>
            <th>Channel</th>
            <th className={styles.num}>Units</th>
            <th className={styles.num}>Revenue</th>
            <th className={styles.num}>Variable costs</th>
            <th className={styles.num}>Contribution</th>
            <th className={styles.num}>CAC</th>
            <th className={styles.num}>LTV</th>
            <th className={styles.num}>LTV:CAC</th>
            <th className={styles.num}>Lifetime profit</th>
            <th>Payback</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const m = metrics.get(r.id);
            if (!m) return null;
            return (
              <tr key={r.id}
                  className={`${styles.segClickable} ${m.lifetimeProfit < 0 ? styles.segLoss : ''}`}
                  onClick={() => onOpen(r.id)}>
                <td className={styles.segName}>
                  {m.lifetimeProfit < 0 && <span className={styles.lossMark} aria-label="loss-making">▼</span>}
                  {r.full_name}
                  {r.is_team_member && <span className={styles.profTeamPill}>team</span>}
                </td>
                <td>{r.region_code ? regionName(r.region_code) : '—'}</td>
                <td>{channelLabel(r.acquisition_channel)}</td>
                <td className={styles.num}>{m.units}</td>
                <td className={styles.num}>{fmtShort(m.revenue)}</td>
                <td className={styles.num}>{fmtShort(m.variableCosts)}</td>
                <td className={`${styles.num} ${m.contributionMargin < 0 ? styles.negative : ''}`}>
                  {fmtShort(m.contributionMargin)}
                </td>
                <td className={styles.num}>
                  {m.cacBasis === 'allocated' ? fmtShort(m.cac ?? 0)
                    : <span className={styles.unpriced}>—</span>}
                </td>
                <td className={styles.num}>{fmtShort(m.realizedLtv)}</td>
                <td className={styles.num}>{m.ltvCac == null ? '—' : `${m.ltvCac.toFixed(1)}×`}</td>
                <td className={`${styles.num} ${m.lifetimeProfit < 0 ? styles.negative : styles.positive}`}>
                  {fmtShort(m.lifetimeProfit)}
                </td>
                <td className={styles.paybackCell}>{paybackShort(m)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function paybackShort(m: CustomerMetrics): string {
  switch (m.payback.status) {
    case 'immediate':     return 'at sale';
    case 'not_recovered': return `${fmtShort(m.payback.remainingCad)} short`;
    case 'no_cac':        return 'no spend';
    case 'unknown':       return '—';
  }
}

function ProfitCard({ row, onOpen }: { row: CustomerProfitability; onOpen: () => void }) {
  const margin = row.net_margin_cad;
  const basis = costsBasis(row);
  const mb = marginBasis(row);
  const tone = margin < 0 ? styles.profCardLoss : margin === 0 ? styles.profCardFlat : styles.profCardWin;

  const refundLine = row.expected_refund_cad === row.settled_refund_cad
    ? fmt(row.expected_refund_cad)
    : `${fmt(row.expected_refund_cad)} (${fmt(row.settled_refund_cad)} settled)`;

  const warrantyLine = row.open_replacement_count === 0
    ? fmt(row.expected_warranty_cost_cad)
    : `${fmt(row.expected_warranty_cost_cad)} (${row.open_replacement_count} in-flight)`;

  // null = nobody has set support_rates.hourly_cad yet. Say so rather than
  // printing $0.00, which would read as "these calls cost nothing".
  const supportLine = row.support_cost_cad == null
    ? (row.diagnosis_call_count > 0 ? 'rate not set' : fmt(0))
    : `${fmt(row.support_cost_cad)} (${minutesLabel(row.diagnosis_minutes)})`;

  // Stocking + inspection + the return leg, shown as one line with the split
  // in the tooltip so the card doesn't grow three more rows.
  const returnHandlingTitle = [
    `${row.returns_handled} unit(s) came back`,
    `stocking ${fmt(row.return_stocking_cad ?? 0)}`,
    `inspection ${fmt(row.return_inspection_cad ?? 0)}`,
    row.return_freight_cad
      ? `return freight ${fmt(row.return_freight_cad)}`
      : 'return freight not on file',
  ].join(' · ');

  return (
    <div className={`${styles.profCard} ${tone}`} onClick={onOpen} role="button" tabIndex={0}
         onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}>
      <div className={styles.profCardHead}>
        <div className={styles.profCardName}>
          {row.full_name}
          {row.is_team_member && <span className={styles.profTeamPill}>team</span>}
        </div>
        <div className={styles.profCardMeta}>
          {row.email ?? '—'}
          {row.region_code ? <> · {row.region_code}</> : row.country ? <> · {row.country}</> : null}
        </div>
      </div>
      <div className={styles.profMargin}>{fmt(margin)}</div>
      <div className={styles.profCardLabel}>
        net margin
        {!mb.fullyMeasured && (
          <Est basis={mb.partial.length > 0 ? 'partial' : 'estimated'}
               title={`Rests on figures that are not invoiced: ${
                 [...mb.partial, ...mb.estimated, ...mb.unpriced].join(', ')}.`} />
        )}
      </div>
      <dl className={styles.profCardBreakdown}>
        <div title="net of sales tax — tax is passed through to the govt, not VCycene revenue">
          <dt>Revenue</dt><dd>{fmt(row.revenue_cad)}</dd>
        </div>
        {row.tax_collected_cad > 0 && (
          <div title="sales tax collected for the govt (not in margin)">
            <dt>Tax</dt><dd className={styles.profTaxLine}>+{fmt(row.tax_collected_cad)}</dd>
          </div>
        )}
        <div title={row.cogs_modelled_count > 0
          ? `${row.cogs_actual_count} of ${row.cogs_actual_count + row.cogs_modelled_count} order(s) costed from the invoiced batch price; the rest use the V-SAX roadmap projection`
          : 'costed from the invoiced batch price of the unit that shipped'}>
          <dt>COGS</dt>
          <dd>
            {fmt(row.sale_cogs_cad)}
            <Est basis={basis.cogs}
                 title={row.cogs_modelled_count > 0
                   ? `${row.cogs_modelled_count} of ${row.cogs_actual_count + row.cogs_modelled_count} order(s) use the roadmap projection rather than an invoiced batch price`
                   : undefined} />
          </dd>
        </div>
        {row.legacy_shipping_cad > 0 && (
          <div title={`${row.legacy_shipment_count} pre-Freightcom shipment(s) (Canpar/GLS/Purolator/FedEx, Oct 2025 - Jan 2026), entered by hand from the carrier records. Attributed to the customer, not to an order.`}>
            <dt>Legacy freight</dt>
            <dd>
              {fmt(row.legacy_shipping_cad)}
              <span className={styles.profUncostedHint}> ({row.legacy_shipment_count})</span>
            </dd>
          </div>
        )}
        <div title={row.shipping_uncosted_count > 0
          ? `${row.shipping_uncosted_count} order(s) that appear to have shipped have no freight invoice on file — real freight is higher than this. Cancelled and still-unshipped orders are not counted. "Appear to have shipped" is judged from this customer's shipped machines, so a repeat buyer may over-count.`
          : 'summed from the Freightcom invoices for this order'}>
          <dt>Shipping</dt>
          <dd>
            {fmt(row.sale_shipping_cad)}
            {row.shipping_uncosted_count > 0 && (
              <span className={styles.profUncostedHint}> ({row.shipping_uncosted_count} uncosted)</span>
            )}
            <Est basis={basis.shipping} />
          </dd>
        </div>
        <div title="cogs + shipping on all non-cancelled replacement orders">
          <dt>Exp. warranty</dt><dd>{warrantyLine}</dd>
        </div>
        <div title="all refund approvals that haven't been denied">
          <dt>Exp. refunds</dt><dd>{refundLine}</dd>
        </div>
        {row.returns_handled > 0 && (
          <div title={returnHandlingTitle}>
            <dt>Return handling</dt>
            <dd>
              {fmt(row.return_handling_cad ?? 0)}
              {!row.return_freight_cad && (
                <span className={styles.profUncostedHint}
                      title="no return-leg freight on file for this customer — the real cost is higher">
                  {' '}(freight missing)
                </span>
              )}
            </dd>
          </div>
        )}
        {row.diagnosis_call_count > 0 && (
          <div title={row.support_cost_cad == null
            ? 'Diagnosis-call labour. Set support_rates.hourly_cad to price it.'
            : `${row.diagnosis_call_count} call(s), billed as time on the call x internal attendees x the blended person-hour rate`}>
            <dt>Support</dt>
            <dd>
              {supportLine}
              <Est basis={basis.support} />
              {row.diagnosis_noshow_count > 0 && (
                <span className={styles.profUncostedHint}
                      title="calls the customer never joined — billed like any other call, since the team's time was spent either way">
                  {' '}({row.diagnosis_noshow_count} no-show)
                </span>
              )}
            </dd>
          </div>
        )}
        {row.fulfilment_cost_cad > 0 && (
          <div title={`${row.fulfilment_order_count} order(s) handled by the 3PL since the contract began on 23 Jun 2026 — order fee plus picks, at the contracted rate card. Estimated: no FlexSpace invoice is on file. Carrier cost is not included here, it is already in Shipping.`}>
            <dt>3PL handling</dt>
            <dd>
              {fmt(row.fulfilment_cost_cad)}
              <span className={styles.profUncostedHint}> ({row.fulfilment_order_count})</span>
              <Est basis={basis.fulfilment} />
            </dd>
          </div>
        )}
        {row.consumables_cost_cad > 0 && (
          <div title={`${row.consumable_item_count} consumable/part order(s) bought at retail and shipped to this customer (worm castings, repair parts). Cost of goods, not freight — the postage on them was free.`}>
            <dt>Consumables</dt>
            <dd>
              {fmt(row.consumables_cost_cad)}
              <span className={styles.profUncostedHint}> ({row.consumable_item_count})</span>
            </dd>
          </div>
        )}
      </dl>
      <div className={styles.profCardCounts}>
        <span>{row.order_count} orders</span>
        <span>{row.replacement_count} replacements</span>
        <span>{row.refund_count} refunds</span>
        <span>{row.ticket_count} tickets</span>
        {row.diagnosis_call_count > 0 && (
          <span title={`${minutesLabel(row.diagnosis_minutes)} of diagnosis calls${row.diagnosis_noshow_count > 0 ? `, ${row.diagnosis_noshow_count} of them no-shows` : ''}`}>
            {row.diagnosis_call_count} diagnosis
          </span>
        )}
        {row.open_warranty_ticket_count > 0 && (
          <span className={styles.profStatWarn} title="Open warranty/defect tickets with no replacement order yet — expected warranty will likely grow when these convert">
            ⚠ {row.open_warranty_ticket_count} open warranty
          </span>
        )}
      </div>
    </div>
  );
}

/** "1h 20m" / "45m" — minutes are stored as a decimal from the recording. */
function minutesLabel(mins: number): string {
  const total = Math.round(mins);
  if (total < 60) return `${total}m`;
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

function SummaryStat({ label, value, variant, est }: {
  label: string; value: string; variant?: 'good' | 'bad' | 'warn'; est?: BucketBasis;
}) {
  const cls = variant === 'good' ? styles.profStatGood
            : variant === 'bad'  ? styles.profStatBad
            : variant === 'warn' ? styles.profStatWarn
            : '';
  return (
    <div className={`${styles.profStat} ${cls}`}>
      <div className={styles.profStatLabel}>{label}{est && <Est basis={est} />}</div>
      <div className={styles.profStatValue}>{value}</div>
    </div>
  );
}

/** The visible half of the model's "never present an unmeasured number as
 *  measured" rule. Renders nothing when a figure really is invoiced. */
export function Est({ basis, title }: { basis: BucketBasis; title?: string }) {
  if (basis === 'actual') return null;
  const cls = basis === 'unpriced' ? styles.estMarkUnpriced
            : basis === 'partial' ? styles.estMarkPartial
            : '';
  const text = basis === 'partial' ? 'part est' : basis === 'unpriced' ? 'unpriced' : 'est';
  return (
    <span className={`${styles.estMark} ${cls}`}
          title={title ?? `This figure is ${BASIS_LABEL[basis]}, not taken from an invoice.`}>
      {text}
    </span>
  );
}

function EstimateLegend() {
  return (
    <p className={styles.estLegend}>
      <span><strong>How to read the figures:</strong></span>
      <span><Est basis="estimated" /> a rate x a quantity, not a bill</span>
      <span><Est basis="partial" /> partly invoiced, partly projected</span>
      <span><Est basis="unpriced" /> no rate set, so the cost reads 0 and margin is an upper bound</span>
      <span>no mark = invoiced</span>
    </p>
  );
}

function hasActivity(r: CustomerProfitability): boolean {
  return r.order_count > 0
      || r.replacement_count > 0
      || r.refund_count > 0
      || r.expected_warranty_cost_cad > 0
      || r.expected_refund_cad > 0
      || r.open_warranty_ticket_count > 0
      // Support time is activity. Antonio Gonsalves and Dhruv Talwar have
      // diagnosis calls but no orders on file — without this they'd be
      // filtered out and their labour cost would never be visible.
      || r.diagnosis_call_count > 0
      || r.returns_handled > 0;
}

function volumeKey(m: CustomerMetrics): string {
  if (m.units === 0) return 'no_purchase';
  if (m.units === 1) return 'single_unit';
  if (m.units <= 3) return 'multi_unit';
  return 'fleet';
}

function sortFn(key: SortKey, metrics: Map<string, CustomerMetrics>):
  (a: CustomerProfitability, b: CustomerProfitability) => number {
  const profit = (r: CustomerProfitability) => metrics.get(r.id)?.lifetimeProfit ?? 0;
  const cac = (r: CustomerProfitability) => metrics.get(r.id)?.cac ?? 0;
  switch (key) {
    case 'profit_desc':   return (a, b) => profit(b) - profit(a);
    case 'profit_asc':    return (a, b) => profit(a) - profit(b);
    case 'margin_desc':   return (a, b) => b.net_margin_cad - a.net_margin_cad;
    case 'margin_asc':    return (a, b) => a.net_margin_cad - b.net_margin_cad;
    case 'warranty_desc': return (a, b) => b.expected_warranty_cost_cad - a.expected_warranty_cost_cad;
    case 'revenue_desc':  return (a, b) => b.revenue_cad - a.revenue_cad;
    // Sorts on minutes, not dollars, so it still ranks before a rate is set.
    case 'support_desc':  return (a, b) => b.diagnosis_minutes - a.diagnosis_minutes;
    case 'cac_desc':      return (a, b) => cac(b) - cac(a);
  }
}

function aggregate(rs: CustomerProfitability[]) {
  return rs.reduce(
    (acc, r) => ({
      revenue:   acc.revenue   + r.revenue_cad,
      tax:       acc.tax       + r.tax_collected_cad,
      salesCost: acc.salesCost + r.sale_cogs_cad + r.sale_shipping_cad + (r.legacy_shipping_cad ?? 0),
      warranty:  acc.warranty  + r.expected_warranty_cost_cad,
      refund:    acc.refund    + r.expected_refund_cad,
      support:   acc.support   + (r.support_cost_cad ?? 0),
      returnHandling: acc.returnHandling + (r.return_handling_cad ?? 0),
      consumables: acc.consumables + (r.consumables_cost_cad ?? 0),
      fulfilment: acc.fulfilment + (r.fulfilment_cost_cad ?? 0),
      // Any priced call at all means the rate is live; without this the bar
      // would show $0.00 and read as "support is free".
      supportPriced: acc.supportPriced || r.support_cost_cad != null,
      margin:    acc.margin    + r.net_margin_cad,
    }),
    { revenue: 0, tax: 0, salesCost: 0, warranty: 0, refund: 0, support: 0, supportPriced: false, returnHandling: 0, consumables: 0, fulfilment: 0, margin: 0 },
  );
}

function ratesSummary(rates: { payment_fee_pct: number; sales_commission_pct: number; installation_cost_per_unit_cad: number }) {
  const unpricedBuckets: string[] = [];
  if (isUnpriced(rates.payment_fee_pct)) unpricedBuckets.push('Payment fees');
  if (isUnpriced(rates.sales_commission_pct)) unpricedBuckets.push('Sales commission');
  if (isUnpriced(rates.installation_cost_per_unit_cad)) unpricedBuckets.push('Installation');
  return { unpricedBuckets };
}

function fmt(n: number | null): string {
  if (n == null) return '—';
  return formatMoney(n, 'CAD');
}

function fmtShort(n: number): string {
  const sign = n < 0 ? '−' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-CA')}`;
}

function pct(v: number | null): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(0)}%`;
}

// ── Backlog #58 V2 — insights panel + cohort helpers ────────────────────────

function cohortOf(r: CustomerProfitability): string {
  const anchor = r.acquired_on ?? r.onboard_date;
  if (!anchor) return 'unknown';
  return anchor.slice(0, 7);
}

function buildCohortOptions(rows: CustomerProfitability[]):
  { key: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = cohortOf(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({
      key,
      label: key === 'unknown' ? 'Unknown' : key,
      count,
    }))
    .sort((a, b) => b.key.localeCompare(a.key));
}

function buildRegionOptions(rows: CustomerProfitability[]):
  { key: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.region_code) continue;
    counts.set(r.region_code, (counts.get(r.region_code) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, label: regionName(key), count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

type Insights = {
  byCountry: { country: string; n: number; avgMargin: number; avgWarranty: number }[];
  repeatWarranty: { n: number; avgMargin: number; baselineAvgMargin: number };
  cohortWarrantyTop: { cohort: string; n: number; warrantyRate: number; avgMargin: number }[];
};

function computeInsights(rows: CustomerProfitability[]): Insights {
  const active = rows.filter(hasActivity);

  const buckets = new Map<string, CustomerProfitability[]>();
  for (const r of active) {
    const k = r.country === 'CA' || r.country === 'US' ? r.country : 'Other';
    const arr = buckets.get(k) ?? [];
    arr.push(r);
    buckets.set(k, arr);
  }
  const byCountryStats = ['CA', 'US', 'Other']
    .map(country => {
      const arr = buckets.get(country) ?? [];
      const n = arr.length;
      if (n === 0) return { country, n, avgMargin: 0, avgWarranty: 0 };
      const avgMargin   = arr.reduce((s, r) => s + r.net_margin_cad, 0) / n;
      const avgWarranty = arr.reduce((s, r) => s + r.expected_warranty_cost_cad, 0) / n;
      return { country, n, avgMargin, avgWarranty };
    })
    .filter(b => b.n > 0);

  const repeaters = active.filter(r => r.replacement_count >= 2);
  const baselineActive = active;
  const repeatWarranty = {
    n: repeaters.length,
    avgMargin: repeaters.length
      ? repeaters.reduce((s, r) => s + r.net_margin_cad, 0) / repeaters.length
      : 0,
    baselineAvgMargin: baselineActive.length
      ? baselineActive.reduce((s, r) => s + r.net_margin_cad, 0) / baselineActive.length
      : 0,
  };

  const cohortBuckets = new Map<string, CustomerProfitability[]>();
  for (const r of active) {
    const k = cohortOf(r);
    if (k === 'unknown') continue;
    const arr = cohortBuckets.get(k) ?? [];
    arr.push(r);
    cohortBuckets.set(k, arr);
  }
  const cohortWarrantyTop = Array.from(cohortBuckets.entries())
    .filter(([, arr]) => arr.length >= 3)
    .map(([cohortKey, arr]) => {
      const n = arr.length;
      const withWarranty = arr.filter(r => r.expected_warranty_cost_cad > 0).length;
      return {
        cohort: cohortKey,
        n,
        warrantyRate: withWarranty / n,
        avgMargin: arr.reduce((s, r) => s + r.net_margin_cad, 0) / n,
      };
    })
    .sort((a, b) => b.warrantyRate - a.warrantyRate)
    .slice(0, 5);

  return { byCountry: byCountryStats, repeatWarranty, cohortWarrantyTop };
}

function InsightsPanel({ insights }: { insights: Insights }) {
  const { byCountry: countryStats, repeatWarranty, cohortWarrantyTop } = insights;
  return (
    <div className={styles.profInsights}>
      <div className={styles.profInsightsHeader}>Insights</div>
      <div className={styles.profInsightsGrid}>
        <div className={styles.profInsightCard}>
          <div className={styles.profInsightTitle}>Avg margin by country</div>
          {countryStats.length === 0 ? (
            <div className={styles.profInsightEmpty}>No active customers.</div>
          ) : (
            <table className={styles.profInsightTable}>
              <thead><tr><th>Country</th><th>N</th><th>Avg margin</th><th>Avg exp. warranty</th></tr></thead>
              <tbody>
                {countryStats.map(b => (
                  <tr key={b.country}>
                    <td>{b.country}</td>
                    <td>{b.n}</td>
                    <td className={b.avgMargin < 0 ? styles.profStatBad : styles.profStatGood}>{fmt(b.avgMargin)}</td>
                    <td className={styles.profStatWarn}>{fmt(b.avgWarranty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className={styles.profInsightCard}>
          <div className={styles.profInsightTitle}>Repeat-warranty customers (≥2 replacements)</div>
          {repeatWarranty.n === 0 ? (
            <div className={styles.profInsightEmpty}>None yet.</div>
          ) : (
            <div className={styles.profInsightStats}>
              <div><span className={styles.profInsightStatValue}>{repeatWarranty.n}</span><span className={styles.profInsightStatLabel}>customers</span></div>
              <div>
                <span className={`${styles.profInsightStatValue} ${repeatWarranty.avgMargin < 0 ? styles.profStatBad : styles.profStatGood}`}>
                  {fmt(repeatWarranty.avgMargin)}
                </span>
                <span className={styles.profInsightStatLabel}>avg margin</span>
              </div>
              <div>
                <span className={styles.profInsightStatValue}>{fmt(repeatWarranty.baselineAvgMargin)}</span>
                <span className={styles.profInsightStatLabel}>baseline (all active)</span>
              </div>
            </div>
          )}
        </div>

        <div className={styles.profInsightCard}>
          <div className={styles.profInsightTitle}>Worst cohorts by warranty rate</div>
          {cohortWarrantyTop.length === 0 ? (
            <div className={styles.profInsightEmpty}>Need ≥3 customers per cohort.</div>
          ) : (
            <table className={styles.profInsightTable}>
              <thead><tr><th>Cohort</th><th>N</th><th>Warranty %</th><th>Avg margin</th></tr></thead>
              <tbody>
                {cohortWarrantyTop.map(c => (
                  <tr key={c.cohort}>
                    <td>{c.cohort}</td>
                    <td>{c.n}</td>
                    <td className={styles.profStatWarn}>{(c.warrantyRate * 100).toFixed(0)}%</td>
                    <td className={c.avgMargin < 0 ? styles.profStatBad : ''}>{fmt(c.avgMargin)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
