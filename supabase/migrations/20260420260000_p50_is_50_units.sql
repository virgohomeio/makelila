-- User clarification 2026-04-20: P50 batch has 50 units, serials 1-50
-- (not 60 as the inventory HTML snapshot originally suggested). Serials
-- 51-60 belong to the P150 batch — those slots were seeded as P50 by the
-- initial migration.

-- Relabel 51-59 (060 was already flipped by the MaxxUs-is-P150 migration)
-- and apply the P150 triage rule (ready/scrap w/o customer → rework).
update public.units
   set batch = 'P150',
       status = case
         when customer_name is null then 'rework'
         else status
       end,
       defect_reason = coalesce(
         defect_reason,
         case when customer_name is null
           then 'Pending triage (P150 batch 35% defect rate).'
           else null
         end
       ),
       notes = case
         when customer_name is null then 'P150 (serial 51-60). Pending triage per 2026-04-20.'
         else notes
       end
 where batch = 'P50'
   and serial between 'LL01-00000000051' and 'LL01-00000000060';

-- Fix the batch metadata so the Stock card KPIs reflect reality.
update public.batches set unit_count = 50 where id = 'P50';
