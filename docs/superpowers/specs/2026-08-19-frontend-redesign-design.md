# makeLILA Frontend Redesign — Design

**Date:** 2026-08-19
**Status:** Approved for planning
**Scope:** Whole-app UI redesign — shell, navigation, design system, and migration of all routed modules.

---

## 1. Problem

makeLILA works, but it is hard to move through. Six problems were confirmed by the operator:

| # | Problem |
|---|---|
| A | **Can't find things.** 12 flat nav modules, no grouping. You must already know Refunds lives under Fulfillment. |
| B | **Same concept in several places.** Returns, Replacements, Claims and Onboarding each appear under two or three modules. |
| C | **No "what do I do next."** Desktop lands on Team. Nothing surfaces what is waiting on you. |
| D | **Every module looks different.** ~12,500 lines of CSS across 29 files; tables, cards and filters rebuilt per module. |
| E | **Mobile is a separate, thinner app.** Parallel component path that drifts from desktop. |
| F | **Screens feel dense and cramped.** |

### Root cause of D — measured, not assumed

The app runs **two complete neutral palettes simultaneously**:

- The brand warm ramp defined in `app/src/styles/tokens.css` — `#2C2A25` / `#5C564E` / `#A39B8F` / `#E8E0D4` / `#F5F1EB`.
- A cool blue-gray ramp hardcoded across module CSS — `#1a202c` / `#4a5568` / `#718096` / `#cbd5e0` / `#e2e8f0`. Roughly 200 uses, inherited from a component library that was never removed.

Counted across `app/src/modules/**/*.module.css`: **1,099 hardcoded hex literals** against **1,646 `var(--token)` references**. Modules sitting side by side genuinely are different colours. This is a plumbing problem and is fixable mechanically.

### A second measured defect

Brand red `#CC2D30` — rgb(204,45,48) — and error red `#c53030` — rgb(197,48,48) — are indistinguishable. A destructive warning currently carries the same visual weight as the primary call to action.

---

## 2. Goals and non-goals

**Goals**
1. One consistent visual language across every module.
2. Navigation where hierarchy is visible without clicking.
3. A landing page that answers "what needs me today."
4. Keep the LILA brand exactly as it is — palette, wordmark, warm neutrals.
5. Preserve existing functionality.

**Non-goals**
- No feature work, no schema changes, no new data flows.
- No re-theming of the brand.
- No mobile redesign (see §7).
- No refactor of `lib/*` data layer beyond what the UI migration strictly requires.

---

## 3. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Personalisation | **Shared grouped nav + role-aware home** | One navigation everyone can talk about; personal starting point where it matters. Avoids eight different-looking apps. |
| Shell | **Grouped left sidebar**, collapsible | Fulfillment already overflows a horizontal row at 9 sub-tabs, and reaches 11 once Shipping folds in. Sidebar spends vertical space (abundant) not horizontal (scarce), and is the only option where the second level is visible without clicking. |
| Mobile | **Keep the fork, restyle it** | Nobody currently uses makeLILA on a phone. Deferred deliberately, not deleted. |
| Density | **Compact (~34px rows)** | Assumed — see §10 Open Questions. Cramping is fixed by alignment and quieter borders, not padding. |
| Brand | **Unchanged** | Operator instruction. |

---

## 4. Information architecture

Four sidebar sections. All 12 existing modules remain reachable.

```
OPERATIONS
  Sales          Pending · Held · Flagged · Confirmed · Replacement · All
  Fulfillment    Queue · Inventory Shelf · History · Shipping · Invoices ·
                 Delivery Map · Returns · Refunds · Replacements ·
                 Cancellations · Claims
  Stock          LILA Units · Parts & Consumables · Unlinked · Build

SERVICE
  Onboarding · Follow-Ups · Support Tickets · Replacement · Inbox
  Lovely ▾      Users · Activity · Verification · App Onboarding · Firmware

CUSTOMERS
  Directory · Journey · Profitability · Fleet

BUSINESS
  Products · Team · Marketing · Finance · Hiring
```

### Changes from today

1. **Shipping stops being a top-level module.** Its Claims tab is deleted as a duplicate of Fulfillment's Claims. Its remaining two tabs — Shipping, Invoices — move into Fulfillment immediately after History.
2. **Lovely nests under Service.** The section keeps the name "Service." Lovely's `Onboarding` tab is renamed **App Onboarding** to resolve a label collision with Service's own Onboarding (customers in their first 30 days). Label change only.
3. **Customers becomes its own section** rather than sitting under a Revenue group.
4. **Business holds Products, Team, Marketing, Finance, Hiring.** Marketing, Finance and Hiring are already permission-gated, so most operators see only Products and Team there — the least-used section sits at the bottom of the rail.

### Routed surfaces vs module directories

There are 19 directories under `app/src/modules/` but only ~11 routed surfaces. Several directories already render inside others:

- `PostShipment/*` tabs render inside `Fulfillment/index.tsx`
- `Service/ReplacementTab` renders inside `Fulfillment/index.tsx`
- `Build/` renders inside `Stock/index.tsx`
- `Dashboard/` is lazy-loaded inside `Customers/index.tsx`
- `Templates/`, `Upload/` render inside `OrderReview`; `ActivityLog/` inside `Team`

Migration is therefore scoped by **routed surface**, not by directory.

> Note: these cross-module imports already violate the `AGENTS.md` rule "modules import from `lib/` only." The redesign does not fix this, but new shared UI must live in `components/ui/`, never be imported module-to-module.

### Known duplication left in place

`Replacement(s)` still appears in Sales, Fulfillment and Service. Merging them is a functional change and is explicitly out of scope. Flagged, not fixed.

---

## 5. Design system

### 5.1 Colour

Brand tokens in `tokens.css` are correct and stay. Changes:

- **Deepen error red** so it is distinguishable from Ladybug Red: `--color-error` moves from `#c53030` to `#7F1D1D`. Measured: `#c53030` sits at a 1.038 relative-luminance ratio from `#CC2D30` (indistinguishable); `#7F1D1D` sits at 1.90, and holds 10.02:1 against white for text use.
- **Ladybug Red `#CC2D30` is reserved for action and attention only** — primary buttons, active nav item, unread counts. Never a decorative fill, never a status background.
- **Delete the cool ramp.** Every `#718096`, `#4a5568`, `#e2e8f0`, `#cbd5e0`, `#f7fafc`, `#edf2f7`, `#1a202c` maps onto the warm equivalent.
- Status colours (success/warning/info/purple) stay, referenced only via tokens.

### 5.2 Typography

- **Inter stays** for all UI. **Brolink stays reserved for the wordmark.**
- New type scale as tokens: page title 20/700, section 15/600, body 13/400, meta-label 11/600 uppercase with tracking.
- **All identifiers and quantities get monospaced tabular figures** — order refs, serials, money, counts, dates. Digits must align vertically in columns. New `--font-mono` token.

### 5.3 New tokens required

`tokens.css` currently defines colour, two fonts, and four sizing values. It gains: a 4px-based spacing scale (4 / 8 / 12 / 16 / 24 / 32 / 48), the type scale above, `--font-mono`, elevation/shadow levels, row-height constants, and a focus-ring definition.

### 5.4 Component set

New directory `app/src/components/ui/`. Nothing exists here today — the current `components/` folder holds only shell and mobile pieces.

| Component | Replaces |
|---|---|
| `Button` | ad-hoc `<button>` styling in 19 CSS files |
| `StatusPill` | per-module badge classes |
| `Card` | per-module card classes |
| `DataTable` | hand-rolled tables in every module |
| `Tabs` | 8+ bespoke tab-strip implementations |
| `FilterBar` | per-module filter rows |
| `PageHeader` | inconsistent titles/breadcrumbs |
| `DetailPanel` | per-module detail drawers |
| `EmptyState` | ad-hoc empty text |
| `Field` / `Input` / `Select` | form controls across Forms + every editor |
| `Modal`, `Toast` | ad-hoc overlays |
| **`StageRail`** | new — see below |

### 5.5 Signature element — the Stage Rail

Almost everything in makeLILA moves through a lifecycle: an order through assign → test → dock → label → email → fulfilled; a build through the pipeline; a ticket through its states; a return through received → inspected → refunded. Each module draws this differently today, or not at all.

`StageRail` is one horizontal component: filled Charcoal behind you, Ladybug Red at your current stage, Warm Linen ahead, with dwell time on the active stage. It encodes real information rather than decorating, and learning it once means being able to read every module. This is the only place the design spends boldness; everything around it stays quiet.

It is distinct from the existing `UnitTimeline`, which is a vertical log of *what happened*. StageRail shows *where something is* in a fixed sequence. Both coexist.

---

## 6. Shell and journey

- **Sidebar** — four sections, module rows, sub-tab rows under the active module. Collapsible to icons. Active path highlighted at every level. Counts render as badges on rows that have queues.
- **Command palette (⌘K)** — searches all ~55 destinations plus records. This is the real escape hatch for a nav of this size and is required in every option considered.
- **Breadcrumb** in `PageHeader`: `Operations / Fulfillment / Queue`.
- **Role-aware home** replaces the current redirect to `/team`. It shows counts and the top few rows for the queues the signed-in user owns — for a fulfillment operator, orders awaiting test/dock/label; for support, open tickets and overdue follow-ups. Every figure derives from data the modules already fetch: no new tables, no new endpoints. Roles come from the existing `lib/permissions.ts` and the responsibilities already encoded in the Team module.

---

## 7. Mobile

The fork stays. `MobileHome`, `MobileTabbedModule`, `MobileBackHeader`, `NavCard` and the `useIsMobile()` branches in 12 modules are **not** removed. They are restyled to consume the same tokens and primitives so the two paths stop diverging visually.

Convergence is explicitly deferred. The trigger for revisiting is real phone usage — most likely a warehouse scanning flow.

---

## 8. Migration strategy

Six phases. Each ships independently and leaves the app working.

**Phase 0 — Foundation.** Extend `tokens.css`. Fix the error red. Add a lint rule banning raw hex in `*.module.css` so the cool ramp cannot come back.

**Phase 1 — Primitives.** Build `components/ui/*` with tests. No module changes yet.

**Phase 2 — Shell.** Sidebar, command palette, PageHeader/breadcrumb. Route changes: fold Shipping into Fulfillment, nest Lovely under Service, rename Lovely's Onboarding to App Onboarding. Old paths redirect, as `App.tsx` already does for `build`, `post-shipment`, `templates`, `dashboard`, `activity-log`, `upload`.

**Phase 3 — Pilot migration: Fulfillment.** The highest-leverage surface — it absorbs Shipping, owns the queue that motivates StageRail, and pulls in PostShipment's tabs. Proves the primitives against the hardest case before fanning out. **Checkpoint: review before continuing.**

**Phase 4 — Remaining surfaces, one module at a time.** Strictly sequential — one surface per branch/PR, merged and verified before the next begins. Operator constraint: the platform should never absorb more than one module of visual change at once. Order, easiest-first to build confidence before the largest: Team · Finance · Products · Hiring · Stock (+Build) · Sales · Customers (+Dashboard) · Marketing · Forms · Service (+Lovely).

**Phase 5 — Role-aware home.**

**Phase 6 — Cleanup.** Delete dead module CSS, restyle the mobile path, enforce the lint rule.

### Sizing

139 `.tsx` files across 19 module directories, ~31,900 lines, with 103 existing test files. Phase 4 is the bulk of the work. It is sequential by operator instruction, so its duration is the sum of its surfaces, not the longest one.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Long period where migrated and unmigrated modules look different | Unavoidable given sequential migration, and accepted. Phase order puts shell + one full surface first so the new language appears early; each surface is a small, self-contained PR |
| `DataTable` cannot absorb every bespoke table | Pilot phase exists to find this before 10 more surfaces depend on it |
| Route changes break deep links operators have bookmarked | Redirect every old path, following the existing precedent in `App.tsx` |
| Regression in untested UI | 103 test files exist; primitives get their own tests; e2e specs run per phase |
| Scope creep into feature work | Non-goals in §2 are explicit; duplication merges are deferred |

---

## 10. Open questions

1. **Density** — Compact (~34px rows) is assumed. Not explicitly confirmed. Reversible: it is one token value.
2. **Fulfillment's History tab** — the operator has flagged that its purpose needs rethinking. Left as-is; not blocking.
3. **Replacement duplication** — three locations, deliberately unmerged. Revisit as separate feature work.
