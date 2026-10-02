# Support tickets for team members — design

**Date:** 2026-09-24
**Module:** Service › Support (New ticket), with a new `lib/team.ts`
**Operator ask:** "I wanted to create a support ticket for Huayi Gao, but
realized I couldn't because he's not a customer, he's a team member. Make it
possible to create support tickets for team members who have LILA Pro units.
Huayi's unit's serial number is 208."

## Problem

The New Ticket dialog requires a customer: `canSubmit` is false until one is
picked, and the picker only searches `customers`. A team member running a LILA
Pro at home or on their desk therefore cannot be the subject of a ticket.

The workaround that suggests itself — give the team member a customer record —
is the thing to avoid. It has already happened four times: `Huayi Gao`,
`Pedrum Amin`, `George Yin` and `Support LILA` all sit in `public.customers`
under `@virgohome.io` addresses, and between them carry six orders and four
tickets. Staff in that table land in customer counts, the purchaser CSV export,
the Klaviyo push, and every profitability rollup that divides by customers.

Meanwhile there are 15 team units (`is_team_test` or `status = 'team-test'`),
and only three record who holds them — as free text in `units.customer_name`:
"Pedrum", "Junaid Siddiqui - Office Machine", "Hassan - Marketing Intern". The
other twelve, Huayi's `LL01-00000000208` among them, are blank.

## What we're building

### 1. The team roster becomes readable (`lib/team.ts`)

`public.team_invite_list` (email → display_name, 9 rows, already
`select`-able by any authenticated user) becomes the app's roster. It is
already the canonical list; `TicketDetailPanel` carries a hand-kept copy of it
in `OPS_OWNERS` with a comment saying it should query the table directly. This
is the first consumer that does.

- `useTeamRoster()` — the members, plus a `Set` of their emails.
- `matchTeamMembers(roster, query)` — pure name/email search, same shape as the
  customer search beside it.
- `teamUnits(units)` — units where `is_team_test` or `status === 'team-test'`.
- `holderMatchesMember(unit, member)` — pure. A unit's free-text
  `customer_name` names this member when it starts with their display name
  ("Pedrum" matches "Pedrum"; "Junaid" matches "Junaid Siddiqui - Office
  Machine"). Prefix, not substring, so "George" can't claim a unit held by
  "Georgia".
- `isTeamTicket(ticket, teamEmails)` — pure. True when a ticket has no
  `customer_id` and its email is a roster address. This is what lets every
  surface tell a team ticket apart without a new column.
- `setTeamUnitHolder(serial, displayName)` — writes `units.customer_name`,
  logs `stock_team_holder`.

### 2. The ticket dialog takes a subject, not a customer

The "Customer *" field becomes "Subject *". One search box, results in two
labelled groups: **Customers** and **Team**. Picking a team member:

- stores `customer_id: null`, `customer_name: <display name>`,
  `customer_email: <their roster address>`, `customer_phone: null`
- offers their team units in the serial field: the ones whose holder already
  names them first, then the team units with no holder recorded
- when the operator picks an unheld team unit, the holder is written to
  `units.customer_name` on create, so the next ticket for that person
  auto-fills and the unit stops being anonymous

The customer path is untouched.

### 3. Staff never reach Klaviyo

`createTicket` currently fires a `Support Ticket Opened` Klaviyo event keyed on
`customer_email`. For a team subject that would file a colleague as a marketing
profile. `createTicket` gains `is_team`, and skips the Klaviyo event entirely
when it is set — the ticket still writes its `ticket_created` activity-log row.

### 4. Huayi → LL01-00000000208

Recorded by setting that unit's `customer_name` to `Huayi`, the same field and
the same shape as Pedrum's and Junaid's. It is a one-row data write, not a
schema change; it goes in as a migration for repeatability and is applied
directly so the feature is useful the moment it deploys.

## Not doing

- **No new table and no new column.** DB migrations here are gated behind a
  manual workflow and are not applied on push, so a design needing one would
  ship broken. Everything above runs on tables that already exist.
- **Not cleaning up the four staff customer rows.** `Pedrum Amin` and
  `Support LILA` carry orders and `George Yin` carries tickets; deciding what
  those represent is a data question for an operator, not a side effect of this
  change. Worth raising separately.
- **Not touching `OPS_OWNERS`.** Pointing the ticket-owner dropdown at the
  roster is the obvious follow-up now that `lib/team.ts` exists, but it changes
  who can be assigned work and belongs in its own change.

## Testing

- `lib/team.test.ts` — `matchTeamMembers` (name, email, case, empty query),
  `holderMatchesMember` (prefix not substring, suffixed names, blank holder),
  `isTeamTicket` (roster email with no customer_id is team; the same email
  WITH a customer_id is not; a customer address is not).
- `modules/Service/__tests__/NewTicketModal.team.test.tsx` — a team member is
  findable and selectable, Create is enabled once one is picked, the ticket is
  written with a null `customer_id` and the roster email, `is_team` is set, and
  picking an unheld team unit records the holder.
