# makeLILA Feature Backlog — Alpha Feedback

> Compiled from the "makeLILA app beta release" email thread (Apr 21 – May 26, 2026)
> 
> Contributors: Pedrum Amin, George Yin, Junaid Siddiqui
> 
> Status: Raymond Zhu feedback still pending (due by May 28 fulfillment day)

---

## P1 — High Priority (multiple requestors or CEO-mandated)

### 1. Google Maps Address Verification
**Source:** Pedrum (Apr 29 + May 26)
**Description:** Auto-check customer addresses against Google Maps API on order sync. Detect postal/ZIP mismatches between what the customer entered and what Google Maps returns. Trigger automated email asking the customer to confirm the correct version.
**Flow:** Order synced → address validated → mismatch detected → email sent to customer with both versions → customer confirms → address updated in makeLILA + Shopify.

### 2. Returns & Refunds Module (move from Google Sheets to makeLILA)
**Source:** Pedrum (Apr 29), George (May 24)
**Description:** Full returns workflow inside makeLILA, replacing the current Google Sheets process.

**Requirements from George:**
- Add "Reason for Return" field with dropdown: Product Defect, Software Issue, Shipping Damage, Customer Service Issue, Financing Issue, Other
- Return & Refund Dashboard showing: Responsible Team, Returns by Channel, Return by Unit Conditions, Monthly Returns Trend (current year)
- Finance Review step with:
  - Button/checkbox for finance review completion
  - Access to correct refund amount (handle partial refunds — e.g. Katrina Dowd case where lila.vip missed a partial refund)
  - Notes field explaining corrections
  - Refund method selection: Shopify, Sezzle financing, QuickBooks credit card, or bank e-transfer
- **Business rule:** No refund processed before receiving returned unit
- **Business rule:** Customer-paid shipping cost is non-refundable

**Requirements from Pedrum:**
- Approval layer (George reviews/approves; Julie may also be involved)

### 3. Email/SMS Templates for Common Scenarios
**Source:** Pedrum (Apr 29 + May 26)
**Description:** Built-in templates for common fulfillment communications:
- Missing phone number follow-up
- Missing email follow-up
- Address verification mismatch (tied to feature #1)
- Return label sent
- Replacement unit shipped
- General status update

Should support both email and SMS channels. Templates should be editable by the team.

### 4. Shopify Order/Payment Summary Sync
**Source:** Pedrum (May 26)
**Description:** Sync the full Shopify order financial breakdown into makeLILA:
- Product subtotal
- Tax amount (if any)
- Shipping amount paid by customer
- Discount codes applied
- Total paid
- Payment method

This data is needed for accurate refund calculations (Finance Review) and operational visibility.

---

## P2 — Medium Priority (single requestor, clear value)

### 5. Machine-Level Tracking Fields (QC/Fulfillment)
**Source:** Junaid (May 26)
**Description:** Per-machine tracking to replace Feishu, with the following fields:

| Field | Description |
|-------|-------------|
| Firmware Version | What firmware version the machine was shipped with |
| Technician | Who last touched the machine before shipping |
| Defect Notes | Editable free-text notes for any defect information |
| Electrical Pass/Fail | Three-state: Pass, Fail, Incomplete (current Feishu tick box doesn't differentiate incomplete from failed) |
| Mechanical Pass/Fail | Same three-state as Electrical |

These fields should live on the Serial Tracker and be visible/editable during the fulfillment flow.

### 6. Shopify Two-Way Sync
**Source:** Pedrum (Apr 29)
**Description:** Currently unclear if address/contact changes in Shopify propagate back to makeLILA after initial order sync. Need:
- Ongoing sync of address/contact changes from Shopify → makeLILA
- Clarify if makeLILA edits should push back to Shopify (bidirectional)
- Define conflict resolution if both sides change

### 7. Freightcom/ClickShip Integration Dedup
**Source:** Pedrum (Apr 29)
**Description:** ClickShip already syncs Shopify order data. Investigate whether the fulfillment team still needs to manually input data into Freightcom. Goal: eliminate double-entry if ClickShip already has the data.

---

## P3 — Lower Priority / Strategic Questions

### 8. HubSpot Relationship Clarification
**Source:** Pedrum (Apr 29)
**Description:** Define whether makeLILA replaces HubSpot for support ticketing or sits alongside it. Current concern: platform overload and data duplication across HubSpot + makeLILA + Shopify. Need a clear "system of record" decision per data type.

### 9. Klaviyo Integration for Email Automation
**Source:** Huayi (May 26, in reply to Pedrum)
**Description:** Integrate with Klaviyo for automated email flows. Could power the email templates (feature #3) and address verification outreach (feature #1) through Klaviyo's infrastructure rather than building email sending from scratch.

---

## Post-alpha additions

### 12. Outbound replies from tickets via support@virgohome.io
**Source:** Huayi (May 27, while wiring Quo→ticket polling)
**Description:** Tickets currently land in makelila from Gmail and (soon) OpenPhone/Quo, but operators can't reply from within makelila. Add a "Reply" composer to the TicketDetailPanel that sends through the `support@virgohome.io` mailbox (probably via Gmail API send-on-behalf or a Resend-from address). Threads outbound replies into the same ticket. Out of scope for v1 of the Quo integration; tracked here for follow-up.

---

## Raymond Zhu Feedback (May 27)

### 10. Link Customer → their Order(s) from the Customers module
**Source:** Raymond Zhu (May 27 email)
**Description:** From the Customers tab, when an operator opens a customer's record they currently see name, email, phone, and location — but there's no jump to that customer's order(s) in the Order Review / Post-Shipment / Fulfillment modules. Add a clickable list (or button) on the customer detail that shows their orders + opens the relevant module's detail panel.

### 11. Customer detail: show full address instead of just "location"
**Source:** Raymond Zhu (May 27 email)
**Description:** The `location` field on the Customer detail is too coarse for workflow use. Show the full address (street + city + region + postal + country) instead. Data exists on `customers` (address_line, city, region, postal_code, country); UI just needs to render all of it.

---

## Feedback Status (as of 2026-05-27)

- ✅ **Pedrum Amin** — items #1, #3, #4 (Apr 29 + May 26)
- ✅ **George Yin** — item #2 (May 24)
- ✅ **Junaid Siddiqui** — item #5 (May 26)
- ✅ **Raymond Zhu** — items #10, #11 (May 27)
- **Reina George** — Was asked to populate Pedrum's feedback onto the CJM (May 7). Status unknown; ops feedback overlaps with the meeting-derived backlog (follow-up calendar, ticket autocomplete, etc.).
- ~~**Aaron, Ashwini**~~ — Co-op terms complete; left the company. No feedback expected.
- ~~**Kevin**~~ — In China; not collecting feedback this round.

Alpha feedback collection window is **closed**. The 11 items above plus the meeting-derived backlog are the working scope.

---

## In-person team walkthrough (2026-05-28)

> Source: in-person review at the office with Pedrum (Sales & Marketing), Raymond + Junaid (Fulfillment & Stock), and Reina (Customer Service). Recap also captured in Fireflies. 32 items below, organized by team area; numbering continues from the alpha-feedback set.

### Sales & Marketing — Pedrum

- **#13** Verify-address: returns "Could not verify" too often. Google Maps Geocoding is unreliable on Canadian rural addresses. Investigate an LLM-backed verifier (Claude) as a fallback or replacement. *Follow-up to shipped #1.*
- **#14** Freight estimate fails to render on some orders (e.g. Joseph's) — ops had to compute manually.
- **#15** Freight estimate must account for line-item quantity (currently appears to assume single unit).
- **#16** Freight estimate text doesn't show on the order card in some states.
- **#17** Surface the freight-estimate source (ClickShip / Freightcom / Shopify) on the card so ops know which system the number came from.
- **#18** Change freight estimate display currency to **CAD** (currently USD).
- **#19** Pull freight estimate from **ClickShip or Freightcom**, not Shopify. Shopify totals include our free-shipping promo + $100 credit, which makes the number wrong for refund and cost math. *Ties to pending #7 ClickShip dedup.*
- **#20** Shopify Payment Summary: show currency code per line. *Follow-up to shipped #4.*

### Fulfillment & Stock — Raymond & Junaid

- **#21** Reverse the "assign serial" flow. Today the order auto-suggests an available unit and ops chase the machine. Desired: prep a unit to "ready" status in Stock first, then assign it to a customer/order later.
- **#22** Stock state out-of-sync. Serial 284 was shipped to Linda but the app still offers it as available for Joseph. Need a full re-sync from physical inventory + Notion IQC log.
- **#23** Add a search bar for unit serial numbers on the "assign to customer" picker so ops can type a known serial.
- **#24** Create a Google Drive folder for electrical test reports and link it from the unit detail panel so techs can attach reports per unit.
- **#25** Add **Canpar** and **GLS** to the carrier dropdown on the shipment step.
- **#26** Fulfillment back-button bug: after selecting a serial for one customer, navigating back leaves the unit marked unavailable for other customers within the session — needs to release the hold on back-out.
- **#27** Rename "Customer / Location" column header in the Stock tab (label mismatched with what's actually shown).
- **#28** To-dock handoff checklist: add a "Carrier picked up" step.
- **#29** Tracking-link email to customer didn't auto-send during testing — debug the send-template-email trigger on shipment commit.
- **#30** Auto-confirm customer receipt — either delivery webhook from the carrier or a follow-up SMS/email asking the customer to confirm.

### Customer Service — Reina

- **#31** Onboarding tab: split into "needs onboarding — not yet scheduled" vs. "onboarding scheduled" sections so Reina can see who to chase.
- **#32** Calendly sync delay. Reina scheduled an onboarding session with Huayi (using Pedrum's test profile) and Pedrum accepted it, but the booking didn't appear in makeLILA promptly. Tighten the sync cadence or webhook.
- **#33** Onboarding detail panel currently reuses the ticket layout. Needs an onboarding-specific view with a "Mark complete" button instead of ticket fields.
- **#34** Customer picker for new tickets didn't surface Pedrum's secondary profile (`pedruma71@gmail.com`). That profile is also missing from the Customers tab. Customer-sync gap.
- **#35** *(Note for later — strategic.)* If we rule HubSpot out as a customer source, we'll need a robust Shopify → customer sync. Today there's a rare Shopify import path that fails to create the customer profile on order arrival. *Ties to #8 system-of-record decision.*
- **#36** "Create support ticket" form: once a customer is selected, auto-populate their unit serial number(s).
- **#37** Ticket status labels need refresh — action-oriented terms like "Complete", "Needs to reach out", etc.
- **#38** Add a Category field on tickets so we can report issue volume per area (electrical, mechanical, onboarding, billing, etc.).
- **#39** Owner-email list is stale: Aaron and Ashwini still appear (both left); Reina is missing.
- **#40** Follow-up calendar based on onboarding date — auto-schedule 1-week / 1-month check-ins after onboarding completes.
- **#41** Define the support-ticket → Repair tab pipeline. Today it's ambiguous how a defect-flagged ticket moves into the repair queue.
- **#42** Customers tab: data sync is incomplete — fields missing on some customers. Likely linked to #34.
- **#43** Add unit serial number to the customer profile card in the Customers tab (currently you have to cross-reference Stock).
- **#44** Auto-invite Reina to every customer onboarding call when it is scheduled in Calendly.

---

## Reference

- Email thread: "makeLILA app beta release, VCycene, Huayi" (started Apr 21, 2026)
- Demo video: [Google Drive link](https://drive.google.com/file/d/1Mqx-wjIzedkeNfkR-0c-nDJw_lrAeWPP/view?usp=sharing)
- Fireflies recap: [makeLILA beta demo v1](https://app.fireflies.ai/view/makeLILA-beta-demo-v1-mp4::01KPVHNYP2K58QRFFVQ2R1FZYT)
- Return checklist reference: Google Sheet "VCycene_Return_Checklist" (per George)
