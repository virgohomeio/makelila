# Issue Reference Links (GitHub / Notion / Documents)

**Date:** 2026-07-18
**Status:** Approved design, pending implementation plan

## Context

The Products dashboard's AI issue-intake chat (`product-issue-chat` edge
function, shipped in PR #44) currently supports a single optional `link` per
filed issue. In practice, `product_issues.link` is unused — every seeded row
has it null, and the chat's system prompt only weakly invites "a link if you
have one." The final whole-branch review on #44 flagged that this field is
collected but never rendered anywhere in the UI, and that it has no scheme
validation (a `javascript:` URL would be stored, matching a known bug class
already tracked elsewhere in this codebase — Lovely App's SEC-06).

This spec makes reference-gathering a deliberate, multi-item part of intake:
the chat explicitly asks for any GitHub links, Notion pages, or documents
relevant to the issue before filing, stores each as its own row, classifies
it by type, and — closing the gap the review flagged — actually displays
them on the Issues tab.

## Goals

- The chat asks, as part of its standard pre-filing checklist, whether
  there's a related GitHub issue/PR, Notion page, or other document —
  "none" is an acceptable answer, this must never block filing.
- An issue can carry zero or more references, each classified as
  `github` | `notion` | `doc` | `other`.
- Reference URLs are validated server-side (http/https scheme only) before
  storage — no client-supplied or model-supplied string reaches the
  database, let alone a rendered `<a href>`, without going through this
  check.
- References display on each issue's card in the existing per-product
  Issues tab — clickable, labeled by kind.
- No change to `IssueChatPanel.tsx` — this is a conversational ask, not a
  new form field.

## Non-Goals

- Editing or removing a reference after it's filed (matches the existing
  no-edit-after-filing scope of the whole issue-intake feature).
- Fetching metadata about the linked resource (page titles, previews,
  GitHub issue status, etc.) — just the raw URL and its classified kind.
- Migrating away from single-turn `product_issues.link`'s data — there is
  none to migrate (every existing row has it null).
- Any change to the dashboard's fleet-wide stats (`computeFleetStats`) —
  references don't factor into open/critical/MP-blocker counts.

## Design

### 1. Migration

One migration file:

```sql
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

alter publication supabase_realtime add table public.product_issue_references;
```

No insert/update policy — same reasoning as `product_issues`: all writes
go through the edge function's service-role client.

Dropping `link` is safe: every row (49 seeded + anything filed since #44
shipped) has it null, confirmed before writing this spec.

### 2. Edge function (`product-issue-chat`)

**System prompt.** The pre-filing checklist gains a fourth item alongside
product/description/accountable-person/severity: "any related links —
GitHub issue or PR, Notion page, or other document. If they say there are
none, that's a complete answer — don't keep asking." The JSON contract's
`issue` object drops `"link"` and gains:
```
"references": ["<url>", ...]   // empty array if none given
```

**Validation.** `validateIssue()` no longer touches links. A new pure,
exported (for testing) function:

```typescript
export type ReferenceKind = 'github' | 'notion' | 'doc' | 'other';
export type ClassifiedReference = { url: string; kind: ReferenceKind };

export function classifyReferences(urls: unknown): ClassifiedReference[] {
  // ...
}
```

Behavior:
- Accepts the raw `references` field from the model's JSON (validates it's
  an array of strings; non-array or missing → `[]`).
- Trims each entry; drops anything that isn't a `string` or doesn't start
  with `http://` or `https://` (case-insensitive) — this is the scheme
  gate that closes the `javascript:`-URL risk before these are ever
  rendered as links.
- Dedupes (case-sensitive exact match after trim).
- Caps at 10 (drops the rest) — defensive limit, not expected to bind in
  practice.
- Classifies each surviving URL by hostname: `github.com` → `github`;
  `notion.so` or `notion.site` → `notion`; `docs.google.com` or
  `drive.google.com` → `doc`; anything else → `other`.

Invalid/dropped URLs never block filing — an issue with zero valid
references still files normally.

**Insert.** On a successful file, after inserting the `product_issues` row,
insert one row per classified reference into `product_issue_references`
with the returned `issue.id` as `issue_id`, in the same handler call.

### 3. `lib/products.ts`

```typescript
export type ReferenceKind = 'github' | 'notion' | 'doc' | 'other';
export type IssueReference = { url: string; kind: ReferenceKind };

export interface Issue {
  title: string; sev: IssueSeverity;
  tag: string; team: string; meta: string; mpBlocker?: boolean;
  references: IssueReference[];
}
```

`DbProductIssue`'s select in `useProductIssues()` embeds the join in one
query: `.select('..., product_issue_references(url, kind)')`. `toIssue()`
maps the embedded array into `references`.

Realtime handling changes from "append the new row" (current behavior) to
"refetch the full list on any INSERT to either `product_issues` or
`product_issue_references`" — a two-table join can't be correctly
maintained by appending a single-table payload, and the full dataset
(currently ~50 rows total) is cheap to refetch. The hook subscribes to
both tables on one channel.

### 4. UI — Issues tab

In `app/src/modules/Products/index.tsx`, `IssueRows`' expanded body gains a
References row, rendered only when `issue.references.length > 0`: each
reference is a small clickable pill/link labeled by kind (e.g. "GitHub ↗",
"Notion ↗", "Doc ↗", "Link ↗" for `other`), opening in a new tab
(`target="_blank" rel="noopener noreferrer"`).

`IssueChatPanel.tsx` requires no changes.

## Testing

- `supabase/functions/product-issue-chat/index.test.ts`: unit tests for
  `classifyReferences()` — scheme rejection (including a `javascript:`
  case), dedup, the 10-item cap, and each hostname pattern's classification
  (including the "everything else → other" fallback).
- `app/src/lib/products.test.ts`: extend `toIssue()`'s test to cover the
  embedded `product_issue_references` join producing the right
  `references` array; extend `useProductIssues()`'s realtime test to cover
  a `product_issue_references` INSERT triggering a refetch.
- Manual QA: file an issue via chat mentioning a GitHub PR URL and a Notion
  URL in the same message; confirm both are classified correctly, both
  appear as separate references on the Issues tab, and both open correctly
  in a new tab.
