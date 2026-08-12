-- FR-6 follow-on (Huayi, 2026-08-05): record HOW the primary user of the machine
-- relates to the purchaser of record (e.g. spouse), alongside the existing
-- primary_user_name / _phone / _email trio.
--
-- Stored as text, not an enum: the UI offers a fixed picklist
-- (PRIMARY_USER_RELATIONSHIPS in app/src/lib/customers.ts) plus an "Other…"
-- free-text escape, so the column has to hold values outside the list. Keeping
-- it text means adding a picklist option is a frontend-only change.
--
-- Like the rest of the primary-user fields, no sync writes this — it is
-- operator-curated only (docs/system-of-record.md).

alter table public.customers
  add column if not exists primary_user_relationship text;

comment on column public.customers.primary_user_relationship is
  'FR-6: the primary user''s relationship to the purchaser of record (e.g. Spouse / partner). Operator-curated; free text backing a UI picklist with an Other option.';
