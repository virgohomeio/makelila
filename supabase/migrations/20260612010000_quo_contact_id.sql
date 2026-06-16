-- Add quo_contact_id to service_tickets.
-- Stores the raw E.164 phone number of the Quo "other party" (convo.participants[0]).
-- Separate from customer_phone (which is the value in the customers table) so
-- operators can see what number Quo actually saw vs. what we have on file.
alter table service_tickets
  add column if not exists quo_contact_id text;
