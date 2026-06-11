-- root_cause: LLM-generated specific explanation of why the ticket exists.
-- Complements issue_area (coarse area for reporting) with plain-English detail.
ALTER TABLE service_tickets ADD COLUMN IF NOT EXISTS root_cause text;

-- Log the new fields so every classifier run is fully auditable.
ALTER TABLE ticket_classification_log ADD COLUMN IF NOT EXISTS issue_area text;
ALTER TABLE ticket_classification_log ADD COLUMN IF NOT EXISTS root_cause text;
ALTER TABLE ticket_classification_log ADD COLUMN IF NOT EXISTS suggested_status text;
