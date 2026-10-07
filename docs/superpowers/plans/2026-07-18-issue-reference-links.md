# Issue Reference Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The product-issue-chat asks for related GitHub links, Notion pages, or documents before filing, stores each as a classified reference, and displays them on the Issues tab.

**Architecture:** A new `product_issue_references` table (FK to `product_issues`) replaces the unused single `link` column. The edge function's DeepSeek contract swaps `"link"` for `"references": [url, ...]`; a new pure `classifyReferences()` function validates scheme, dedupes, caps, and classifies each URL server-side (never trusting the model's judgment on type). `lib/products.ts` embeds the join in one query and switches `useProductIssues()`'s realtime handling from "append the new row" to "refetch on any INSERT to either table" — required for a two-table join, and cheap at this data size. `IssueRows` in `index.tsx` gains a References block.

**Tech Stack:** Same as the parent feature — React 18 + TypeScript (Vite), Supabase Postgres + Deno Edge Functions, Supabase JS client v2.

**Spec:** [docs/superpowers/specs/2026-07-18-issue-reference-links-design.md](../specs/2026-07-18-issue-reference-links-design.md)

## Global Constraints

- `product_issues.link` column is dropped (verified: 0 of 51 existing rows have it set)
- New table `product_issue_references(id, issue_id, url, kind, created_at)`, `kind` constrained to `'github' | 'notion' | 'doc' | 'other'`, default `'other'`
- RLS: same `exists (select 1 from public.profiles where id = auth.uid() and is_internal = true)` SELECT-only pattern as every other internal table in this module — no insert/update policy (service-role only)
- Reference URLs must be `http://` or `https://` only — reject anything else (closes the same scheme-injection risk as SEC-06 elsewhere in this codebase) before it's ever classified, stored, or rendered
- Hostname → kind: `github.com` → `github`; `notion.so`/`notion.site` → `notion`; `docs.google.com`/`drive.google.com` → `doc`; else → `other`
- Cap: 10 references per issue, dedupe by exact URL match, silently drop the rest — never blocks filing
- Migrations are applied via the Supabase MCP `apply_migration` tool, not `supabase db push` — consistent with the whole project's established practice on this repo (documented precedent: PR #44, PR #53)
- Components never call `supabase` directly — always through a `lib/` function

---

## File Structure

```
supabase/
  migrations/
    20260718120000_product_issue_references.sql   ← new: drop link, add table + RLS + realtime
  functions/
    product-issue-chat/
      index.ts                                     ← modified: classifyReferences(), prompt, insert
      index.test.ts                                ← modified: + classifyReferences tests
app/
  src/
    lib/
      products.ts                                  ← modified: Issue.references, embedded query, refetch-on-INSERT
      products.test.ts                              ← modified: + references coverage
    modules/
      Products/
        index.tsx                                   ← modified: IssueRows renders references
        Products.module.css                         ← modified: + reference pill styles
```

No new files besides the migration — everything else is a modification to code from the parent feature (already reviewed, merged, live).

---

## Task 1: Migration — product_issue_references table, drop link

**Files:**
- Create: `supabase/migrations/20260718120000_product_issue_references.sql`

**Interfaces:**
- Produces: `public.product_issue_references` table; `public.product_issues` loses its `link` column

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260718120000_product_issue_references.sql
--
-- Adds multi-reference support (GitHub/Notion/doc links) to product issues,
-- replacing the single unused product_issues.link column — verified 0 of 51
-- existing rows have it set, so no data loss.
-- Spec: docs/superpowers/specs/2026-07-18-issue-reference-links-design.md

alter table public.product_issues drop column link;

create table public.product_issue_references (
  id         uuid primary key default gen_random_uuid(),
  issue_id   uuid not null references public.product_issues(id) on delete cascade,
  url        text not null,
  kind       text not null default 'other' check (kind in ('github','notion','doc','other')),
  created_at timestamptz not null default now()
);

alter table public.product_issue_references enable row level security;

create policy "internal users can read product_issue_references"
  on public.product_issue_references for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_internal = true
    )
  );

-- No insert/update policy: all writes go through the product-issue-chat
-- edge function's service-role client. Same pattern as product_issues.

alter publication supabase_realtime add table public.product_issue_references;
```

- [ ] **Step 2: Apply the migration via Supabase MCP**

Use the `apply_migration` MCP tool (not `supabase db push`) with:
- `project_id`: `txeftbbzeflequvrmjjr`
- `name`: `product_issue_references`
- `query`: the exact SQL from Step 1

- [ ] **Step 3: Verify**

Run via the `execute_sql` MCP tool:

```sql
select column_name from information_schema.columns
where table_schema='public' and table_name='product_issues' and column_name='link';
```
Expected: zero rows (column is gone).

```sql
select count(*) from public.product_issue_references;
```
Expected: `0` (table exists, empty).

```sql
select tablename from pg_publication_tables
where pubname='supabase_realtime' and tablename='product_issue_references';
```
Expected: one row (`product_issue_references`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260718120000_product_issue_references.sql
git commit -m "feat(products): add product_issue_references table, drop unused product_issues.link"
```

---

## Task 2: lib/products.ts — Issue.references, embedded query, refetch-on-INSERT

**Files:**
- Modify: `app/src/lib/products.ts`
- Modify: `app/src/lib/products.test.ts`

**Interfaces:**
- Consumes: `public.product_issue_references` (Task 1)
- Produces: `Issue.references: IssueReference[]`; `type ReferenceKind`, `type IssueReference`; `useProductIssues()` now refetches (not appends) on realtime INSERT to either `product_issues` or `product_issue_references`

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `app/src/lib/products.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  toIssue, groupByProduct, computeFleetStats, useProductIssues, sendIssueChatMessage,
  type DbProductIssue,
} from './products';

const { mockResolve, mockOn, mockSubscribe, mockChannel, mockInvoke } = vi.hoisted(() => {
  const mockResolve = vi.fn();
  const mockUnsubscribe = vi.fn();
  const mockOn = vi.fn().mockReturnThis();
  const mockSubscribe = vi.fn().mockReturnThis();
  const mockChannel = vi.fn(() => ({ on: mockOn, subscribe: mockSubscribe, unsubscribe: mockUnsubscribe }));
  const mockInvoke = vi.fn();
  return { mockResolve, mockOn, mockSubscribe, mockUnsubscribe, mockChannel, mockInvoke };
});

vi.mock('./supabase', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {};
  builder.select = () => builder;
  builder.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    mockResolve().then(onFulfilled, onRejected);
  return {
    supabase: {
      from: () => builder,
      channel: mockChannel,
      functions: { invoke: mockInvoke },
    },
  };
});

const ROW_PRO: DbProductIssue = {
  id: 'row-1', product_id: 'pro', title: 'Latch snaps off', severity: 'high',
  tag: 'Hardware · Latch', team: 'Ben Liang', meta: 'Breaks under normal use.',
  mp_blocker: true, source: 'seed', created_by: null, created_by_name: null,
  created_at: '2026-07-01T00:00:00.000Z',
  product_issue_references: [],
};
const ROW_SHOP: DbProductIssue = {
  id: 'row-2', product_id: 'shop', title: 'CAC too high', severity: 'critical',
  tag: 'Marketing', team: 'Pedrum', meta: 'CAC is $400+.',
  mp_blocker: false, source: 'seed', created_by: null, created_by_name: null,
  created_at: '2026-07-01T00:00:00.000Z',
  product_issue_references: [],
};

describe('toIssue', () => {
  it('maps a DB row to the Issue shape', () => {
    expect(toIssue(ROW_PRO)).toEqual({
      title: 'Latch snaps off', sev: 'high', tag: 'Hardware · Latch',
      team: 'Ben Liang', meta: 'Breaks under normal use.', mpBlocker: true,
      references: [],
    });
  });

  it('defaults a null team to an empty string', () => {
    expect(toIssue({ ...ROW_PRO, team: null }).team).toBe('');
  });

  it('maps embedded product_issue_references into the references array', () => {
    const row: DbProductIssue = {
      ...ROW_PRO,
      product_issue_references: [{ url: 'https://github.com/virgohomeio/makelila/pull/1', kind: 'github' }],
    };
    expect(toIssue(row).references).toEqual([
      { url: 'https://github.com/virgohomeio/makelila/pull/1', kind: 'github' },
    ]);
  });
});

describe('groupByProduct', () => {
  it('groups rows by product_id', () => {
    const result = groupByProduct([ROW_PRO, ROW_SHOP, { ...ROW_PRO, id: 'row-3' }]);
    expect(result.pro).toHaveLength(2);
    expect(result.shop).toHaveLength(1);
  });

  it('returns an empty object for no rows', () => {
    expect(groupByProduct([])).toEqual({});
  });
});

describe('computeFleetStats', () => {
  const issuesByProduct = groupByProduct([ROW_PRO, ROW_SHOP]);
  const products = [
    { id: 'pro', stage: 'PP' },
    { id: 'shop', stage: 'GROW' },
    { id: 'mega', stage: 'EP' },
  ];

  it('totals open, critical, and MP-blocker issues across all lines', () => {
    const stats = computeFleetStats(issuesByProduct, products);
    expect(stats.totalOpen).toBe(2);
    expect(stats.totalCritical).toBe(1);
    expect(stats.totalMpBlockers).toBe(1);
    expect(stats.lineCount).toBe(3);
  });

  it('gives each product line its own open/critical count, zero for lines with no issues', () => {
    const stats = computeFleetStats(issuesByProduct, products);
    expect(stats.perLine).toEqual([
      { productId: 'pro', stage: 'PP', openCount: 1, criticalCount: 0 },
      { productId: 'shop', stage: 'GROW', openCount: 1, criticalCount: 1 },
      { productId: 'mega', stage: 'EP', openCount: 0, criticalCount: 0 },
    ]);
  });
});

describe('useProductIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOn.mockReturnThis();
    mockSubscribe.mockReturnThis();
  });

  it('loads rows and groups them by product', async () => {
    mockResolve.mockResolvedValueOnce({ data: [ROW_PRO, ROW_SHOP], error: null });
    const { result } = renderHook(() => useProductIssues());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.issuesByProduct.pro).toHaveLength(1);
    expect(result.current.issuesByProduct.shop).toHaveLength(1);
  });

  it('subscribes to realtime INSERTs on both product_issues and product_issue_references', async () => {
    mockResolve.mockResolvedValueOnce({ data: [], error: null });
    renderHook(() => useProductIssues());
    await waitFor(() => expect(mockChannel).toHaveBeenCalledWith('product_issues:realtime'));
    expect(mockOn).toHaveBeenCalledWith(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'product_issues' },
      expect.any(Function),
    );
    expect(mockOn).toHaveBeenCalledWith(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'product_issue_references' },
      expect.any(Function),
    );
  });

  it('refetches the full list when a product_issues INSERT event fires', async () => {
    mockResolve
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [ROW_PRO], error: null });
    const { result } = renderHook(() => useProductIssues());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.issuesByProduct.pro).toBeUndefined();

    const issuesInsertHandler = mockOn.mock.calls[0][2] as () => void;
    await act(async () => { issuesInsertHandler(); });

    await waitFor(() => expect(result.current.issuesByProduct.pro).toHaveLength(1));
  });

  it('refetches the full list when a product_issue_references INSERT event fires', async () => {
    const rowWithRef: DbProductIssue = {
      ...ROW_PRO,
      product_issue_references: [{ url: 'https://notion.so/x', kind: 'notion' }],
    };
    mockResolve
      .mockResolvedValueOnce({ data: [ROW_PRO], error: null })
      .mockResolvedValueOnce({ data: [rowWithRef], error: null });
    const { result } = renderHook(() => useProductIssues());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.issuesByProduct.pro[0].references).toEqual([]);

    const referencesInsertHandler = mockOn.mock.calls[1][2] as () => void;
    await act(async () => { referencesInsertHandler(); });

    await waitFor(() => expect(result.current.issuesByProduct.pro[0].references).toHaveLength(1));
  });
});

describe('sendIssueChatMessage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invokes the product-issue-chat function and returns its data', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { reply: 'Got it.', filed: false }, error: null });
    const result = await sendIssueChatMessage({
      messages: [{ role: 'user', content: 'latches keep breaking' }],
      product_id: 'pro',
      products: [{ id: 'pro', label: 'LILA Pro' }],
      knownTeam: ['Ben Liang'],
    });
    expect(mockInvoke).toHaveBeenCalledWith('product-issue-chat', {
      body: {
        messages: [{ role: 'user', content: 'latches keep breaking' }],
        product_id: 'pro',
        products: [{ id: 'pro', label: 'LILA Pro' }],
        knownTeam: ['Ben Liang'],
      },
    });
    expect(result).toEqual({ reply: 'Got it.', filed: false });
  });

  it('throws when the function call errors', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: new Error('network down') });
    await expect(sendIssueChatMessage({
      messages: [], product_id: null, products: [], knownTeam: [],
    })).rejects.toThrow('network down');
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd app
npx vitest run src/lib/products.test.ts
```

Expected: failures — `DbProductIssue` still requires `link` and has no `product_issue_references` field, `toIssue()` doesn't return `references`, and the two new realtime tests fail (`useProductIssues` doesn't yet subscribe to `product_issue_references`).

- [ ] **Step 3: Update the implementation**

In `app/src/lib/products.ts`:

Replace:
```typescript
export interface Issue {
  title: string; sev: IssueSeverity;
  tag: string; team: string; meta: string; mpBlocker?: boolean;
}

export type DbProductIssue = {
  id: string;
  product_id: string;
  title: string;
  severity: IssueSeverity;
  tag: string;
  team: string | null;
  meta: string;
  link: string | null;
  mp_blocker: boolean;
  source: 'seed' | 'chat';
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
};

export function toIssue(row: DbProductIssue): Issue {
  return {
    title: row.title,
    sev: row.severity,
    tag: row.tag,
    team: row.team ?? '',
    meta: row.meta,
    mpBlocker: row.mp_blocker,
  };
}
```

with:
```typescript
export type ReferenceKind = 'github' | 'notion' | 'doc' | 'other';
export type IssueReference = { url: string; kind: ReferenceKind };

export interface Issue {
  title: string; sev: IssueSeverity;
  tag: string; team: string; meta: string; mpBlocker?: boolean;
  references: IssueReference[];
}

export type DbProductIssue = {
  id: string;
  product_id: string;
  title: string;
  severity: IssueSeverity;
  tag: string;
  team: string | null;
  meta: string;
  mp_blocker: boolean;
  source: 'seed' | 'chat';
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  product_issue_references: IssueReference[];
};

export function toIssue(row: DbProductIssue): Issue {
  return {
    title: row.title,
    sev: row.severity,
    tag: row.tag,
    team: row.team ?? '',
    meta: row.meta,
    mpBlocker: row.mp_blocker,
    references: row.product_issue_references ?? [],
  };
}
```

Replace:
```typescript
const PRODUCT_ISSUE_COLUMNS =
  'id, product_id, title, severity, tag, team, meta, link, mp_blocker, source, created_by, created_by_name, created_at';
```
with:
```typescript
const PRODUCT_ISSUE_COLUMNS =
  'id, product_id, title, severity, tag, team, meta, mp_blocker, source, created_by, created_by_name, created_at, product_issue_references(url, kind)';
```

Replace the whole `useProductIssues` function:
```typescript
export function useProductIssues(): { issuesByProduct: Record<string, Issue[]>; loading: boolean } {
  const [rows, setRows] = useState<DbProductIssue[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let channel: RealtimeChannel | null = null;

    const fetchRows = async () => {
      const { data, error } = await supabase
        .from('product_issues')
        .select(PRODUCT_ISSUE_COLUMNS);
      if (cancelled) return;
      if (!error && data) setRows(data as DbProductIssue[]);
      setLoading(false);
    };

    (async () => {
      await fetchRows();

      channel = supabase
        .channel('product_issues:realtime')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'product_issues' },
          () => { void fetchRows(); },
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'product_issue_references' },
          () => { void fetchRows(); },
        )
        .subscribe();
    })();

    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { issuesByProduct: groupByProduct(rows), loading };
}
```

(`groupByProduct`, `computeFleetStats`, `FleetLineStat`, `FleetStats`, `ChatTurn`, `ChatResponse`, `sendIssueChatMessage` are all unchanged — leave them exactly as-is.)

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/lib/products.test.ts
```

Expected: all tests pass (14 tests across 5 describe blocks).

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors. (`data.ts` imports `Issue` from this file and doesn't construct any `Issue` literals itself — all 7 products' `issues` arrays are already empty — so this typecheck should be clean with no ripple edits needed there.)

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/products.ts app/src/lib/products.test.ts
git commit -m "feat(products): add Issue.references, embed product_issue_references join, refetch on realtime INSERT"
```

---

## Task 3: Edge function — classifyReferences(), updated prompt and insert

**Files:**
- Modify: `supabase/functions/product-issue-chat/index.ts`
- Modify: `supabase/functions/product-issue-chat/index.test.ts`

**Interfaces:**
- Consumes: `public.product_issue_references` (Task 1)
- Produces: `classifyReferences(urls: unknown): ClassifiedReference[]` (exported for testing); DeepSeek JSON contract's `issue.references` replaces `issue.link`

- [ ] **Step 1: Write the failing tests**

Read the current `supabase/functions/product-issue-chat/index.test.ts` first (it has 6 existing `validateIssue` tests — keep every one of them; they still apply since `validateIssue` itself doesn't change, only what's built around it). Append these new test cases to the same file:

```typescript
import { classifyReferences } from './index.ts';

Deno.test('classifyReferences: accepts and classifies github, notion, and doc URLs', () => {
  const result = classifyReferences([
    'https://github.com/virgohomeio/makelila/pull/44',
    'https://notion.so/some-page-abc123',
    'https://docs.google.com/document/d/xyz',
    'https://drive.google.com/file/d/xyz',
  ]);
  assertEquals(result, [
    { url: 'https://github.com/virgohomeio/makelila/pull/44', kind: 'github' },
    { url: 'https://notion.so/some-page-abc123', kind: 'notion' },
    { url: 'https://docs.google.com/document/d/xyz', kind: 'doc' },
    { url: 'https://drive.google.com/file/d/xyz', kind: 'doc' },
  ]);
});

Deno.test('classifyReferences: unrecognized hostnames classify as other', () => {
  const result = classifyReferences(['https://example.com/some-doc.pdf']);
  assertEquals(result, [{ url: 'https://example.com/some-doc.pdf', kind: 'other' }]);
});

Deno.test('classifyReferences: rejects non-http(s) schemes', () => {
  const result = classifyReferences([
    'javascript:alert(1)',
    'ftp://example.com/file',
    'https://github.com/ok/repo',
  ]);
  assertEquals(result, [{ url: 'https://github.com/ok/repo', kind: 'github' }]);
});

Deno.test('classifyReferences: dedupes exact-match URLs', () => {
  const result = classifyReferences([
    'https://github.com/ok/repo',
    'https://github.com/ok/repo',
  ]);
  assertEquals(result.length, 1);
});

Deno.test('classifyReferences: caps at 10 references', () => {
  const urls = Array.from({ length: 15 }, (_, i) => `https://example.com/doc-${i}`);
  const result = classifyReferences(urls);
  assertEquals(result.length, 10);
});

Deno.test('classifyReferences: non-array input returns empty array', () => {
  assertEquals(classifyReferences(null), []);
  assertEquals(classifyReferences(undefined), []);
  assertEquals(classifyReferences('not an array'), []);
});

Deno.test('classifyReferences: drops non-string and empty entries', () => {
  const result = classifyReferences(['https://github.com/ok/repo', 123, '', '   ', null]);
  assertEquals(result, [{ url: 'https://github.com/ok/repo', kind: 'github' }]);
});
```

(Add the `import { classifyReferences } from './index.ts';` line alongside the existing `import { validateIssue } from './index.ts';` at the top of the file — one import statement per symbol is fine, or combine them into one `import { validateIssue, classifyReferences } from './index.ts';` line, your call, just don't duplicate the module specifier awkwardly.)

- [ ] **Step 2: Run the tests to confirm the new ones fail**

```bash
deno test supabase/functions/product-issue-chat/index.test.ts 2>&1 | head -15
```

Expected: `error: does not provide an export named 'classifyReferences'` — confirms the new tests are wired up correctly; the existing 6 `validateIssue` tests should still be listed (they'll fail to run too since the whole file fails to load until the export exists — that's expected at this stage).

- [ ] **Step 3: Update the implementation**

In `supabase/functions/product-issue-chat/index.ts`:

Replace the `FiledIssue` type (drop `link`):
```typescript
export type FiledIssue = {
  product_id: string;
  title: string;
  severity: Severity;
  tag: string;
  team: string;
  meta: string;
  mp_blocker: boolean;
};
```

Replace `validateIssue()`'s body (remove the `link` line only — everything else is unchanged):
```typescript
export function validateIssue(
  issue: unknown,
  validProductIds: string[],
): FiledIssue | null {
  if (!issue || typeof issue !== 'object') return null;
  const i = issue as Record<string, unknown>;
  if (typeof i.product_id !== 'string' || !validProductIds.includes(i.product_id)) return null;
  if (typeof i.title !== 'string' || !i.title.trim()) return null;
  if (typeof i.meta !== 'string' || !i.meta.trim()) return null;
  if (typeof i.severity !== 'string' || !SEVERITIES.includes(i.severity as Severity)) return null;
  return {
    product_id: i.product_id,
    title: i.title.trim(),
    severity: i.severity as Severity,
    tag: typeof i.tag === 'string' && i.tag.trim() ? i.tag.trim() : 'Other',
    team: typeof i.team === 'string' ? i.team.trim() : '',
    meta: i.meta.trim(),
    mp_blocker: i.mp_blocker === true,
  };
}
```

Add, right after `validateIssue()`:
```typescript
export type ReferenceKind = 'github' | 'notion' | 'doc' | 'other';
export type ClassifiedReference = { url: string; kind: ReferenceKind };

const REFERENCE_CAP = 10;

function classifyKind(url: string): ReferenceKind {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (hostname === 'github.com' || hostname.endsWith('.github.com')) return 'github';
  if (hostname === 'notion.so' || hostname.endsWith('.notion.so')
    || hostname === 'notion.site' || hostname.endsWith('.notion.site')) return 'notion';
  if (hostname === 'docs.google.com' || hostname === 'drive.google.com') return 'doc';
  return 'other';
}

/** Validates and classifies a model-proposed references list. Never trusts
 *  the model's own judgment on URL scheme or kind — every URL is checked
 *  here before it can reach the DB or ever be rendered as a link. Invalid
 *  entries are silently dropped, never block filing. Exported for testing. */
export function classifyReferences(urls: unknown): ClassifiedReference[] {
  if (!Array.isArray(urls)) return [];
  const seen = new Set<string>();
  const out: ClassifiedReference[] = [];
  for (const raw of urls) {
    if (typeof raw !== 'string') continue;
    const url = raw.trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, kind: classifyKind(url) });
    if (out.length >= REFERENCE_CAP) break;
  }
  return out;
}
```

In `buildSystemPrompt()`, replace this line:
```typescript
You need, at minimum, before filing: which product line, a description of the problem (and optionally a link), an accountable person/team, and a severity assessment (critical/high/medium/low — use your judgment based on the description; ask the user only if genuinely ambiguous).
```
with:
```typescript
You need, at minimum, before filing: which product line, a description of the problem, an accountable person/team, a severity assessment (critical/high/medium/low — use your judgment based on the description; ask the user only if genuinely ambiguous), and whether there's any related GitHub issue/PR, Notion page, or other document — if they say there's none, that's a complete answer, don't keep asking.
```

And replace the `issue` object's shape in the JSON contract:
```typescript
    "link": <string URL if one was given, else null>,
```
with:
```typescript
    "references": [<string URL>, ...] | [],
```

In `handle()`, replace:
```typescript
  const { data: inserted, error: insertErr } = await admin
    .from('product_issues')
    .insert({
      product_id: validated.product_id,
      title: validated.title,
      severity: validated.severity,
      tag: validated.tag,
      team: validated.team,
      meta: validated.meta,
      link: validated.link,
      mp_blocker: validated.mp_blocker,
      source: 'chat',
      created_by: caller.user_id,
      created_by_name: profile?.display_name ?? caller.email,
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    return json({ reply: "I had the details but couldn't save the ticket — try again.", filed: false }, 200);
  }
```
with:
```typescript
  const { data: inserted, error: insertErr } = await admin
    .from('product_issues')
    .insert({
      product_id: validated.product_id,
      title: validated.title,
      severity: validated.severity,
      tag: validated.tag,
      team: validated.team,
      meta: validated.meta,
      mp_blocker: validated.mp_blocker,
      source: 'chat',
      created_by: caller.user_id,
      created_by_name: profile?.display_name ?? caller.email,
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    return json({ reply: "I had the details but couldn't save the ticket — try again.", filed: false }, 200);
  }

  const references = classifyReferences(
    (deepseekTurn.issue as Record<string, unknown> | null)?.references,
  );
  if (references.length > 0) {
    await admin.from('product_issue_references').insert(
      references.map(r => ({ issue_id: inserted.id, url: r.url, kind: r.kind })),
    );
  }
```

(The `activity_log` insert right after stays exactly as-is — references don't need their own audit row, they're part of the same `product_issue_filed` event.)

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
deno test supabase/functions/product-issue-chat/index.test.ts --allow-net
```

Expected: 13 tests passing (6 existing `validateIssue` + 7 new `classifyReferences`).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/product-issue-chat/
git commit -m "feat(products): edge function asks for and classifies GitHub/Notion/doc references"
```

- [ ] **Step 6: Deploy**

```bash
cd app
./node_modules/.bin/supabase functions deploy product-issue-chat
```

Expected: `Deployed Function product-issue-chat`

- [ ] **Step 7: Smoke-test**

```bash
curl -s -o /dev/null -w "HTTP_STATUS:%{http_code}\n" -X POST \
  https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/product-issue-chat \
  -H "Content-Type: application/json" -d '{}'
```

Expected: `HTTP_STATUS:401` (correctly rejects unauthenticated requests — confirms the redeploy is live).

---

## Task 4: UI — References display on the Issues tab

**Files:**
- Modify: `app/src/modules/Products/index.tsx`
- Modify: `app/src/modules/Products/Products.module.css`

**Interfaces:**
- Consumes: `Issue.references` (Task 2)

- [ ] **Step 1: Append reference-pill styles to Products.module.css**

Add at the end of `app/src/modules/Products/Products.module.css`:

```css

/* ── Issue references ────────────────────────────────────────────────────── */
.issueRefs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.issueRefLink {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-lt);
  padding: 3px 8px;
  border-radius: 999px;
  text-decoration: none;
}
.issueRefLink:hover { text-decoration: underline; }
```

- [ ] **Step 2: Add the kind-label map near the other display maps**

In `app/src/modules/Products/index.tsx`, find the existing block of display-label constants near the top of the file:

```typescript
const SEV_LABEL: Record<string, string>  = { critical:'C', high:'H', medium:'M', low:'L' };
```

Add immediately after the `SEV_LABEL`/`SEV_CLASS` block:

```typescript
const REF_KIND_LABEL: Record<string, string> = {
  github: 'GitHub', notion: 'Notion', doc: 'Doc', other: 'Link',
};
```

- [ ] **Step 3: Render references in the expanded issue body**

Find, inside `IssueRows`:

```tsx
            {isOpen && <div className={styles.issueBody}>{issue.meta}</div>}
```

Replace with:

```tsx
            {isOpen && (
              <div className={styles.issueBody}>
                {issue.meta}
                {issue.references.length > 0 && (
                  <div className={styles.issueRefs}>
                    {issue.references.map((ref, ri) => (
                      <a
                        key={ri}
                        href={ref.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.issueRefLink}
                        onClick={e => e.stopPropagation()}
                      >
                        {REF_KIND_LABEL[ref.kind] ?? 'Link'} ↗
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
```

(`onClick={e => e.stopPropagation()}` is required — the parent `.issueRow` has its own `onClick` that toggles expand/collapse; without stopping propagation, clicking a reference link would also collapse the card.)

- [ ] **Step 4: Typecheck and build**

```bash
cd app
npx tsc --noEmit
npm run build
```

Expected: both clean.

- [ ] **Step 5: Run the full test suite**

```bash
npx vitest run
```

Expected: all tests passing (existing suite + Task 2's updated `products.test.ts`).

- [ ] **Step 6: Manual QA**

```bash
npm run dev
```

In the browser:
1. Open the Products module → Dashboard tab → file a test issue via chat, and when the bot asks about related links, give it a GitHub PR URL and a Notion page URL in the same message.
2. Confirm the bot files the issue (still asks for product/description/owner/severity as before — the only change is one more question).
3. Navigate to that product's Issues tab, expand the new issue, confirm both references appear as separate clickable pills labeled "GitHub ↗" and "Notion ↗".
4. Click one — confirms it opens in a new tab and does NOT collapse the issue card.
5. File a second test issue and explicitly say "no links" when asked — confirm it still files normally with no References row shown.

- [ ] **Step 7: Commit**

```bash
git add app/src/modules/Products/index.tsx app/src/modules/Products/Products.module.css
git commit -m "feat(products): display issue reference links on the Issues tab"
```
