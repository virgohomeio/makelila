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

## Reference

- Email thread: "makeLILA app beta release, VCycene, Huayi" (started Apr 21, 2026)
- Demo video: [Google Drive link](https://drive.google.com/file/d/1Mqx-wjIzedkeNfkR-0c-nDJw_lrAeWPP/view?usp=sharing)
- Fireflies recap: [makeLILA beta demo v1](https://app.fireflies.ai/view/makeLILA-beta-demo-v1-mp4::01KPVHNYP2K58QRFFVQ2R1FZYT)
- Return checklist reference: Google Sheet "VCycene_Return_Checklist" (per George)
