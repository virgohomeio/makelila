# Inbox Triage — 2026-06-07

> One-off triage pass on the Service Inbox (104 untriaged conversations as of 2026-06-07).
> Bucket A (30) was auto-merged into existing open tickets. B / C / D need operator review.

## Summary

| Bucket | Count | Status | Action |
|---|---|---|---|
| **A** · linked to customer with open ticket | **30** | ✅ shipped 2026-06-07 | Note added to existing ticket, inbox row dispositioned `follow_up` |
| **B** · linked customer, only closed tickets — re-engagement | **11** | ⏳ pending | Decide per-row: promote to new ticket OR mark `dismissed` if it's an outbound check-in with no reply needed |
| **C** · linked customer, no prior ticket — likely new tickets | **27** | ⏳ pending | Promote via Service → Inbox → "Promote to ticket" modal so the conversation gets a real ticket assigned to an owner |
| **D** · no customer linked (Quo contact unresolved) | **36** | ⏳ pending | Look up the actual customer from the Quo conversation (most show `customer_phone=+13658253070`, the LILA Pro Service inbox number itself — Quo never bound the row to a contact). Resolve, then promote or dismiss. |

Total untriaged still in inbox after this pass: **74**.

## Bucket A — merged (30 conversations) ✅

Each row's existing open ticket got a `📥 Inbox conversation merged into this ticket` note with the channel, date range, message count, inbox ticket number, and Quo/Gmail thread reference. The inbox row is now hidden from the untriaged view via `inbox_disposition='follow_up'`.

Ticket owners can spot these by looking for the 📥 prefix in their ticket's Notes feed. If the conversation actually warranted a separate ticket (rare), they can clear the disposition (`inbox_disposition=null`) and re-promote — the merge is reversible.

Customers merged: Amanda McCordic, Ann Prendergast, Annmarie Kennedy, Ashley Wright, Brent Neave, Chad & Sarah Lockhart, Cheryl Lemieux, Chris & Renata Grant, Donna Wood, Ellery Bunn, Fred Rice, Gina Daniels, Heather Hall, James & Jill Washington, Jeffrey Carnahan, Jeffrey Van Dyke, Jefy Chacko, Jenifer Henry, Judy Mahon, Kerriann Fotzpatrick, Kyle Fong, Leen Schafer, Manjeet Kaur, Phayvanh Nanthavongdouangsy, Rebecca Campbell, Rick Stauffer, Ron Russell, Shearries Lafontaine, Sherry Elkins, Ted Dochau.

## Bucket B — re-engagement (11) ⏳

Customer has only closed tickets but a new conversation popped. Could be a real follow-up issue or just an outbound check-in. Operator decides per row.

| Inbox | Customer | Last msg | Msgs | Prior closed | Subject |
|---|---|---|---|---|---|
| ST-2026-0165 | Mary & Marilynne Oskamp | 2026-06-06 | 19 | ST-2026-0033 | Hello Mary, my name is Ash from LILA composter team. Your machine should arri… |
| ST-2026-0293 | Teresa Just | 2026-06-05 | 24 | ST-2026-0065 | Hello Teresa, my name is Ashwini… Just a reminder th… |
| ST-2026-0292 | Amila & Rob Smith | 2026-06-04 | 1 | ST-2026-0069 | Follow-up SMS to Amila & Rob Smith |
| ST-2026-0291 | Teresa Just | 2026-06-04 | 1 | ST-2026-0065 | Follow-up SMS to Teresa Just |
| ST-2026-0179 | Mr. Phil Parkinson | 2026-06-03 | 27 | ST-2026-0077 | Hello Phil, My name is Ashwini… My co-worker Huayi t… |
| ST-2026-0174 | Frederick Whittington | 2026-05-28 | 28 | ST-2026-0085 | Hello Frederick, my name is Ashwini… |
| ST-2026-0177 | Frank Nikolaidis | 2026-05-28 | 17 | ST-2026-0073 | hihi Frank this is Ed - we just chatted on google meet |
| ST-2026-0149 | Kevin Cheng | 2026-05-27 | 17 | ST-2026-0074 | Hi Kevin |
| ST-2026-0173 | Rodney Richards | 2026-05-26 | 20 | ST-2026-0064 | Hello Rodney, my name is Ashwini… |
| ST-2026-0153 | Sarah Harris | 2026-05-26 | 27 | ST-2026-0104 | Hi Sarah, this is Reina from LILA Composter. This is our customer service num… |
| ST-2026-0156 | Lynn Liu | 2026-05-26 | 14 | ST-2026-0022 | hihi Lynn |

**Suggested rule:** message_count ≥ 5 → almost certainly a real conversation worth promoting to a new ticket. The 1-message rows (Amila, Teresa Just) are outbound follow-ups with no reply yet — likely `dismissed`.

## Bucket C — new-ticket candidates (27) ⏳

Linked customer, no prior ticket. Most are early-cycle conversations from active customers (Ronald Hatch, Kristen Pimentel, Suzan Jackovatz, etc.) where there *should* be a ticket capturing the workflow but one was never created. Promote each via the Service → Inbox UI.

| Inbox | Customer | Last msg | Msgs | Subject |
|---|---|---|---|---|
| ST-2026-0164 | Lisa Clarke | 2026-06-06 | 21 | Hello, my name is Ash from LILA composter team. |
| ST-2026-0155 | Ronald Hatch | 2026-06-05 | 56 | Hihi Ron this is Ed from LILA composter |
| ST-2026-0238 | Suzan Jackovatz | 2026-06-05 | 24 | Hello Suzan, my name is Ashwini… |
| ST-2026-0170 | RJ Dowd | 2026-06-05 | **381** | Hello RJ. My name is Ashwini… (high-touch — biggest convo in inbox) |
| ST-2026-0241 | Rashida Lee | 2026-06-04 | 21 | Hello, my name is Ash from LILA composter team. |
| ST-2026-0171 | Michael Romans | 2026-06-04 | 28 | Hello, my name is Ashwini… |
| ST-2026-0248 | Kristen Pimentel | 2026-06-04 | 48 | Hihi Ed from LILA composter |
| ST-2026-0290 | Michael Romans | 2026-06-04 | 1 | Follow-up SMS to Michael Romans |
| ST-2026-0175 | Audrey St John | 2026-06-03 | 53 | Hello Audrey Balany, my name is Ashwini… |
| ST-2026-0250 | Louis DiPalma | 2026-06-03 | 6 | Hihi Lou |
| ST-2026-0282 | Louise Leonard | 2026-06-03 | 3 | Hihi Edward from Lila |
| ST-2026-0246 | Cathy Lin | 2026-05-30 | 6 | Hihi Ed Lila composter here |
| ST-2026-0251 | Mauro Varela | 2026-05-29 | 9 | Hi Mauro |
| ST-2026-0249 | Cole Perkins | 2026-05-29 | 7 | Hello, my name is Ash from LILA composting team. We missed your call earlier. |
| ST-2026-0245 | Lawrence Hou | 2026-05-28 | 3 | Hihi Ed from LILA composter |
| ST-2026-0242 | Tara Dupper | 2026-05-28 | 8 | Hello, we are on the on-boarding call for LILA. Will you be joining? |
| ST-2026-0240 | Antonio Cernuto | 2026-05-28 | 12 | Hi Antonio |
| ST-2026-0237 | Karon Plasha | 2026-05-28 | 23 | Hello Karon, my name is Ashwini… |
| ST-2026-0176 | Dixie Bean | 2026-05-28 | 14 | Hello Dixie, my name is Ashwini… |
| ST-2026-0236 | Robert Buckley | 2026-05-28 | 10 | Hello Robert, my name is Ashwini… |
| ST-2026-0133 | Jeff Mottle | 2026-05-28 | 20 | Hi Jeff, this is Reina from LILA! How's the composting going so far? |
| ST-2026-0227 | Dwayne Binkley | 2026-05-28 | 4 | Hi Dwayne, this is Reina from LILA Pro. |
| ST-2026-0172 | Sandra Sweet | 2026-05-28 | 11 | Hello Sandra, my name is Ashwini… |
| ST-2026-0182 | Lynda South Simoneau | 2026-05-26 | 22 | Hello Lynda, this is Ashwini… Reminder that we have … |
| ST-2026-0169 | Jean Cotis | 2026-05-25 | 13 | Hello, my name is Ashwini… |
| ST-2026-0154 | Erika Turner | 2026-05-25 | 14 | Hihi Erika Ed from LILA composter |
| ST-2026-0141 | Paul Ethier | 2026-05-25 | 2 | Hi Paul, this is Reina from LILA Pro |

**Suggested action:** promote rows with message_count ≥ 5 to a new ticket. The 1–2 message rows are usually unanswered outbound check-ins → `dismissed`.

## Bucket D — unlinked (36) ⏳

`customer_id IS NULL`. Most have `customer_phone=+13658253070` which is the LILA Pro Service inbox number itself — Quo stored the SENDER (us) instead of the contact (them) because the conversation was outbound-initiated and Quo didn't bind to a contact record. **Real customer identity lives in the Quo thread subject line** (e.g. "Hi Albert, this is Reina from LILA Pro. We understand that you are having iss…" → customer is Albert).

| Inbox | Phone (often our own #) | Msgs | Last | Subject (customer hint in italics) |
|---|---|---|---|---|
| ST-2026-0184 | +17809078929 | **106** | 2026-05-26 | *Karolina* — Scott gave Ashwini her number |
| ST-2026-0268 | (our #) | 32 | 2026-06-05 | *Albert* — issues |
| ST-2026-0261 | (our #) | 29 | 2026-05-30 | *Vickie* |
| ST-2026-0235 | +12513486873 | 27 | 2026-05-28 | *Tricia* |
| ST-2026-0140 | (our #) | 16 | 2026-06-06 | *Kelly* |
| ST-2026-0298 | +12892310327 | 15 | 2026-06-07 | *Sarah* (hihi Sarah) |
| ST-2026-0144 | (our #) | 15 | 2026-05-30 | *Michelle* |
| ST-2026-0180 | +18014337124 | 10 | 2026-05-26 | unit serial *LL01-00000000244* |
| ST-2026-0244 | (our #) | 8 | 2026-05-28 | *Myles* |
| ST-2026-0139 | (our #) | 8 | 2026-05-26 | *Cole* — wellness check |
| ST-2026-0259 | (our #) | 8 | 2026-06-05 | *Scott* |

…plus 25 more shorter conversations (full list query below).

**Suggested action:** for each row, click into the Quo conversation via `quo_conversation_id`, identify the customer, run `customerForSerial()`-style lookup or create a contact, then either promote to a new ticket or merge into an existing one. Backlog item worth opening: **Quo contact-resolution at sync time** so future inbound conversations don't land orphaned.

## How the operator should work through this

1. Open Service module → Inbox tab. The 30 merged rows are gone; the remaining 74 are sorted by `last_message_at desc`.
2. For B + C rows: open the Quo conversation, decide promote vs dismiss. Operator UI handles this — no SQL needed.
3. For D rows: same flow but identify the customer first via the Quo thread.

## Audit query

To find every ticket that received a merge note today:

```sql
select t.ticket_number, t.customer_name, t.subject, n.body
from public.ticket_notes n
join public.service_tickets t on t.id = n.ticket_id
where n.author_email = 'system'
  and n.body like '📥 Inbox conversation merged into this ticket%'
order by t.ticket_number;
```

## What the long-term fix looks like

This triage pass should be a one-off. To prevent inbox backlog from re-accumulating:

- **Auto-classification** at Gmail/Quo sync time — if the conversation's customer already has an open ticket, auto-merge as `follow_up` and skip the inbox entirely (only orphan threads need triage).
- **Contact resolution at Quo sync** — don't store our own inbox number as `customer_phone`. Either fall back to NULL or use the Quo `contact_id` lookup.
- Both above land cleanly inside **Junaid's Telemetry-auto-ticket pattern (P1 M)** or **Reina's OKR/KPI tracking (P2 M)** as the place that already touches the inbox classification surface. Worth threading into one of those rather than a standalone backlog item.
