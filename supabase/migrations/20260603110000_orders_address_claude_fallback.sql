-- Walkthrough #13: LLM-backed address verification fallback. When Google's
-- Address Validation API returns "unverifiable" (often on Canadian rural
-- addresses), the verify-address edge fn now calls Claude as a secondary
-- check. These columns record Claude's reasoning so operators can see
-- WHY a verdict was overridden.
alter table public.orders
  add column if not exists address_claude_verdict text
    check (address_claude_verdict is null
        or address_claude_verdict in ('plausible', 'implausible', 'unknown')),
  add column if not exists address_claude_notes   text,
  add column if not exists address_claude_postal  text;
