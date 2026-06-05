-- Backlog #55 follow-up — bring the Service module's Replacement Orders
-- tab in sync with the fulfillment Excel (source of truth for historical
-- replacements that weren't created in-app).
--
-- Two parts:
--   1. Schema: add tracking_num + carrier columns to orders so a
--      replacement order can record "in transit via UPS, 1ZV56D..."
--      Per operator (2026-06-05): tracking_num IS NOT NULL ⇒ shipped;
--      tracking_num IS NULL ⇒ still to be shipped.
--   2. Data: insert 31 replacement orders from
--      `LILA customer fulfillment-20260605.xlsx` → Replacement sheet,
--      assigned R-0002…R-0032 (R-0001 stays as Finley Forrest's
--      existing in-app replacement). Each row carries status='pending'
--      when no tracking + 'approved' (with shipped_at) when tracking is
--      present.
--
-- Idempotency: `on conflict (order_ref) do nothing` so a replay against
-- an env that already has these rows is a no-op.

alter table public.orders
  add column if not exists tracking_num text,
  add column if not exists carrier text;

comment on column public.orders.tracking_num is
  'Carrier tracking number. Replacement orders: presence signals shipped status. Backfilled from the fulfillment Excel.';
comment on column public.orders.carrier is
  'Shipping carrier (UPS, Canpar, Canada Post, ...). Populated alongside tracking_num.';

insert into public.orders (
  order_ref, kind, status, customer_name, customer_email, customer_phone,
  address_line, city, region_state, postal_code, country, currency,
  line_items,
  shipped_at, delivered_at, tracking_num, carrier, shipping_cost_usd,
  total_usd, subtotal_usd, tax_usd, discount_total_usd,
  freight_estimate_usd, freight_threshold_usd, address_verdict, sales_confirmed_fit
) values
  ('R-0002','replacement','pending','Harper Hale','customer04@example.com','555-0111-0000','121 Example St','Grand Rapids','MN','55744','US','USD','[{"kind":"part","description":"both side latch"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0003','replacement','approved','Indigo Irving','customer05@example.com','555-0112-0000','128 Example St','Reno','NV','89511','US','USD','[{"kind":"unit","batch":"P100","unit_serial":"LL01-00000000271"}]'::jsonb,'2026-05-07'::timestamptz,'2026-05-14'::timestamptz,'1ZV56D26DK26632644','UPS',195.44,0,0,0,0,0,0,'house',false),
  ('R-0004','replacement','approved','Jordan Jensen','customer06@example.com','555-0113-0000','135 Example St','Lower Sackville','NS','B4C 2K3','CA','CAD','[{"kind":"unit","batch":"P100","unit_serial":"LL01-00000000307"}]'::jsonb,'2026-05-07'::timestamptz,'2026-05-12'::timestamptz,'D420352470002152685001','Canpar',94.67,0,0,0,0,0,0,'house',false),
  ('R-0005','replacement','pending','Drew Dunn','customer07@example.com','555-0114-0000','142 Example St','Seymour','CT','06483','US','USD','[{"kind":"part","description":"side latch (?) and filter cup"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0006','replacement','approved','Kai Keene','customer08@example.com','555-0115-0000','149 Example St','Eagle Mountain','UT','84005','US','USD','[{"kind":"unit","batch":"P100","unit_serial":"LL01-00000000297"}]'::jsonb,'2026-05-15'::timestamptz,'2026-05-21'::timestamptz,'1ZV56D26DK16622254','UPS',198.83,0,0,0,0,0,0,'house',false),
  ('R-0007','replacement','pending','Logan Lowry','customer09@example.com','555-0116-0000','156 Example St','Maple','ON',null,'CA','CAD','[{"kind":"part","description":"broken compost chamber (right side)"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0008','replacement','pending','Morgan Mercer','customer10@example.com','555-0117-0000','163 Example St','Yucca Valley','CA','92284','US','USD','[{"kind":"part","description":"side latch (? side)"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0009','replacement','approved','Noel Nash','customer11@example.com','555-0118-0000','170 Example St','Etobicoke','ON',null,'CA','CAD','[{"kind":"unit","batch":"P100","unit_serial":"LL01-00000000288"}]'::jsonb,'2026-05-19'::timestamptz,null,'dropped off',null,null,0,0,0,0,0,0,'house',false),
  ('R-0010','replacement','pending','Oakley Oakes',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"part","description":"both compost chambers cracked"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0011','replacement','pending','Parker Pike','customer12@example.com','555-0119-0000','177 Example St','Innerkip','ON',null,'CA','CAD','[{"kind":"part","description":"P100 X"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0012','replacement','approved','Quinn Quill','customer13@example.com','555-0102-0000','184 Example St','Spallumcheen','BC','V4Y 0M1','CA','CAD','[{"kind":"part","description":"right side latch"}]'::jsonb,null,null,'104504378910343','Canada Post',16.39,0,0,0,0,0,0,'house',false),
  ('R-0013','replacement','pending','Reese Rhodes','customer14@example.com','555-0103-0000','191 Example St','San Diego','CA','92126','US','USD','[{"kind":"part","description":"left side chamber"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0014','replacement','approved','Sage Sterling','customer15@example.com','555-0120-0000','198 Example St','Thorold','ON',null,'CA','CAD','[{"kind":"part","description":"starter bags"}]'::jsonb,null,null,'104504378991342','Canada Post',22.95,0,0,0,0,0,0,'house',false),
  ('R-0015','replacement','pending','Tatum Thorne','customer16@example.com','555-0121-0000','205 Example St','Toronto','ON',null,'CA','CAD','[{"kind":"unit_pending","batch":"P150"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0016','replacement','approved','Urban Underhill','customer17@example.com','555-0122-0000','212 Example St','Markham','ON',null,'CA','CAD','[{"kind":"unit","batch":"P100","unit_serial":"LL01-00000000341"}]'::jsonb,'2026-05-19'::timestamptz,null,'dropped off',null,null,0,0,0,0,0,0,'house',false),
  ('R-0017','replacement','pending','Vesper Vance','customer18@example.com','555-0123-0000','219 Example St','Elsipogtog First Nation','NB','E4W 2X5','CA','CAD','[{"kind":"unit_pending","batch":"P150"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0018','replacement','pending','Wren Whitlock',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"unit_pending","batch":"P100X"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0019','replacement','approved','Xen Xander','customer19@example.com','555-0124-0000','226 Example St','Palm Springs','CA','92264','US','USD','[{"kind":"unit","batch":"P100","unit_serial":"LL01-00000000304"}]'::jsonb,'2026-05-15'::timestamptz,'2026-05-22'::timestamptz,'1ZV56D26DK26566350','UPS',204.27,0,0,0,0,0,0,'house',false),
  ('R-0020','replacement','pending','Yael Yardley',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"unit_pending","batch":"P150"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0021','replacement','pending','Zion Zane',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"unit_pending","batch":"P150"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0022','replacement','pending','Ari Ames',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"unit_pending","batch":"P100"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0023','replacement','pending','Bell Birch',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"unit_pending","batch":"P150"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0024','replacement','approved','Cleo Crane','customer20@example.com','555-0125-0000','233 Example St','Seagrave','ON','L0C 1G0','CA','CAD','[{"kind":"unit","batch":"P150","unit_serial":"LL01-00000000150"}]'::jsonb,'2026-06-04'::timestamptz,null,'D420352470002273178001','Canpar',76.90,0,0,0,0,0,0,'house',false),
  ('R-0025','replacement','pending','Dale Doyle',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"unit_pending","batch":"P100"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0026','replacement','pending','Eden East',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"unit_pending","batch":"P150"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0027','replacement','pending','Fern Frost','customer21@example.com','555-0126-0000','240 Example St','Hamburg','NY','14075','US','USD','[{"kind":"part","description":"Replacement top lid"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0028','replacement','pending','Gale Gable',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"part","description":"Right side latch"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0029','replacement','pending','Hollis Holt','customer22@example.com',null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"part","description":"unspecified parts"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0030','replacement','pending','Ira Ipsen','customer23@example.com','555-0127-0000',null,'(unknown)',null,null,'CA','CAD','[{"kind":"part","description":"unspecified parts"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0031','replacement','pending','Joss Jove','customer24@example.com','555-0128-0000','247 Example St','Strathmore','AB','T1P 1W2','CA','CAD','[{"kind":"part","description":"Side latch + compost chambers"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0032','replacement','approved','Lane Kerr','customer25@example.com','555-0129-0000','254 Example St','West Kelowna','BC','V4T 2Y3','CA','CAD','[{"kind":"part","description":"Hopper"}]'::jsonb,'2026-06-04'::timestamptz,null,'1ZV56D262027006405','UPS',21.71,0,0,0,0,0,0,'house',false)
on conflict (order_ref) do nothing;

-- The flag_missing_phone trigger flips status to 'flagged' on insert
-- when customer_phone is null. That logic was designed for sale orders
-- (where missing phone blocks shipping) — not relevant for replacements
-- that are imported with known-incomplete contact data. Unflag here so
-- they show up under the 'pending' filter in the Replacement tab.
update public.orders
set status = 'pending'
where kind = 'replacement'
  and status = 'flagged'
  and tracking_num is null;
