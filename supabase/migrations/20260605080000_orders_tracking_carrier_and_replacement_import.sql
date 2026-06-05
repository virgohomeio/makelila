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
--      assigned R-0002…R-0032 (R-0001 stays as Kristen Pimentel's
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
  ('R-0002','replacement','pending','Jake Wenger','wenger.jake@gmail.com','218-301-4249','20757 Atlantic Puffin Dr, Grand Rapids, MN 55744, USA','Grand Rapids','MN','55744','US','USD','[{"kind":"part","description":"both side latch"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0003','replacement','approved','Brittany Hemenway','bnhemenway@gmail.com','775-250-8351','14032 Crested Moss Ct, Reno, NV, 89511, USA','Reno','NV','89511','US','USD','[{"kind":"unit","batch":"P100","unit_serial":"LL01-00000000271"}]'::jsonb,'2026-05-07'::timestamptz,'2026-05-14'::timestamptz,'1ZV56D26DK26632644','UPS',195.44,0,0,0,0,0,0,'house',false),
  ('R-0004','replacement','approved','Rebecca Campbell','campbellra652@gmail.com','902-818-8352','304-716 Old Sackville Rd., Lower Sackville, NS, B4C 2K3','Lower Sackville','NS','B4C 2K3','CA','CAD','[{"kind":"unit","batch":"P100","unit_serial":"LL01-00000000307"}]'::jsonb,'2026-05-07'::timestamptz,'2026-05-12'::timestamptz,'D420352470002152685001','Canpar',94.67,0,0,0,0,0,0,'house',false),
  ('R-0005','replacement','pending','Annmarie Kennedy','anmarik@comcast.net','203-895-2263','32 Walnut St, Seymour, CT, 06483, USA','Seymour','CT','06483','US','USD','[{"kind":"part","description":"side latch (?) and filter cup"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0006','replacement','approved','Gina Daniels','gdaniels@mw.foreverlawn.com','208-409-3929','3102 Tinamous Rd, Eagle Mountain, UT, 84005, USA','Eagle Mountain','UT','84005','US','USD','[{"kind":"unit","batch":"P100","unit_serial":"LL01-00000000297"}]'::jsonb,'2026-05-15'::timestamptz,'2026-05-21'::timestamptz,'1ZV56D26DK16622254','UPS',198.83,0,0,0,0,0,0,'house',false),
  ('R-0007','replacement','pending','Suzanne McRae','suemmcrae@gmail.com','416-624-9647','43 Peak Point Blvd, Maple, ON, Canada','Maple','ON',null,'CA','CAD','[{"kind":"part","description":"broken compost chamber (right side)"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0008','replacement','pending','Dale Bober','dalebober@gmail.com','760-799-9286','4021 Palo Alto Ave, Yucca Valley, CA, 92284, USA','Yucca Valley','CA','92284','US','USD','[{"kind":"part","description":"side latch (? side)"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0009','replacement','approved','Chris & Renata Grant','cb.grant@hotmail.com','905-301-7988','3 Father Redmond Way, Etobicoke, ON M8W 0B4','Etobicoke','ON',null,'CA','CAD','[{"kind":"unit","batch":"P100","unit_serial":"LL01-00000000288"}]'::jsonb,'2026-05-19'::timestamptz,null,'dropped off',null,null,0,0,0,0,0,0,'house',false),
  ('R-0010','replacement','pending','Jason Amero',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"part","description":"both compost chambers cracked"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0011','replacement','pending','Mark Marshall','m.c.marshall@sympatico.ca','519-533-8989','675369 16th Line Innerkip ON N0J 1M0','Innerkip','ON',null,'CA','CAD','[{"kind":"part","description":"P100 X"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0012','replacement','approved','Brent Baker (Neave)','brent@baker-neave.com','(604) 329-2421','4506 Grizzly Hill Rd., Spallumcheen, British Columbia, V4Y 0M1','Spallumcheen','BC','V4Y 0M1','CA','CAD','[{"kind":"part","description":"right side latch"}]'::jsonb,null,null,'104504378910343','Canada Post',16.39,0,0,0,0,0,0,'house',false),
  ('R-0013','replacement','pending','Leen Schafer','leenschafer@gmail.com','(949) 554-9788','7367 Kamwood Street, San Diego, CA, 92126, USA','San Diego','CA','92126','US','USD','[{"kind":"part","description":"left side chamber"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0014','replacement','approved','Donna Wood','smilesarefree6@gmail.com','905-330-5289','6 Buchanan Cres, Thorold, ON, Canada','Thorold','ON',null,'CA','CAD','[{"kind":"part","description":"starter bags"}]'::jsonb,null,null,'104504378991342','Canada Post',22.95,0,0,0,0,0,0,'house',false),
  ('R-0015','replacement','pending','Tony Rinella','rinellat@hotmail.com','416-783-2550','16 Marianfeld Ave Toronto ON M6B 3W3','Toronto','ON',null,'CA','CAD','[{"kind":"unit_pending","batch":"P150"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0016','replacement','approved','Kevin Cheng','ziontkd.markham@gmail.com','416-887-4779','15 Charlotte Angliss Road Markham ON L3P 7W6','Markham','ON',null,'CA','CAD','[{"kind":"unit","batch":"P100","unit_serial":"LL01-00000000341"}]'::jsonb,'2026-05-19'::timestamptz,null,'dropped off',null,null,0,0,0,0,0,0,'house',false),
  ('R-0017','replacement','pending','Angeline Purcell','annpurcell123@hotmail.com','506-523-7006','499 Main St, Elsipogtog First Nation, NB, E4W 2X5','Elsipogtog First Nation','NB','E4W 2X5','CA','CAD','[{"kind":"unit_pending","batch":"P150"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0018','replacement','pending','Scott Gilbert & Karolina Chmiel',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"unit_pending","batch":"P100X"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0019','replacement','approved','Jeffrey Van Dyke','jeffreyvandyke@comcast.net','971-344-2438','731 E Twin Palms Dr, Palm Springs, CA, 92264, USA','Palm Springs','CA','92264','US','USD','[{"kind":"unit","batch":"P100","unit_serial":"LL01-00000000304"}]'::jsonb,'2026-05-15'::timestamptz,'2026-05-22'::timestamptz,'1ZV56D26DK26566350','UPS',204.27,0,0,0,0,0,0,'house',false),
  ('R-0020','replacement','pending','Tien Tran',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"unit_pending","batch":"P150"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0021','replacement','pending','Michael Madigan',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"unit_pending","batch":"P150"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0022','replacement','pending','Tamara Martin',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"unit_pending","batch":"P100"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0023','replacement','pending','Candace Chan',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"unit_pending","batch":"P150"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0024','replacement','approved','Ellery Bunn','ellery.bunn@gmail.com','416-797-9143','182 Southcrest Dr, Seagrave, ON L0C 1G0','Seagrave','ON','L0C 1G0','CA','CAD','[{"kind":"unit","batch":"P150","unit_serial":"LL01-00000000150"}]'::jsonb,'2026-06-04'::timestamptz,null,'D420352470002273178001','Canpar',76.90,0,0,0,0,0,0,'house',false),
  ('R-0025','replacement','pending','Brian Fryer',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"unit_pending","batch":"P100"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0026','replacement','pending','Connie Beatty',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"unit_pending","batch":"P150"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0027','replacement','pending','Fred Rice','ricefj50@yahoo.com','814-688-7182','6284 Smith Rd, Hamburg, NY, 14075, USA','Hamburg','NY','14075','US','USD','[{"kind":"part","description":"Replacement top lid"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0028','replacement','pending','Patrick Taylor',null,null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"part","description":"Right side latch"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0029','replacement','pending','Shearries Moseley Lafontaine','shearries@gmail.com',null,null,'(unknown)',null,null,'CA','CAD','[{"kind":"part","description":"unspecified parts"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0030','replacement','pending','Jeff Carnahan','worldcoast@gmail.com','236-333-6787',null,'(unknown)',null,null,'CA','CAD','[{"kind":"part","description":"unspecified parts"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0031','replacement','pending','Vicki Myhre','svmyhre@shaw.ca','403-901-9472','115 Hillview Rd, Strathmore, AB, T1P 1W2','Strathmore','AB','T1P 1W2','CA','CAD','[{"kind":"part","description":"Side latch + compost chambers"}]'::jsonb,null,null,null,null,null,0,0,0,0,0,0,'house',false),
  ('R-0032','replacement','approved','Judy Mahon','judymml@sasktel.net','306-441-7110','2562 Cornerstone Ct, West Kelowna, BC, V4T 2Y3','West Kelowna','BC','V4T 2Y3','CA','CAD','[{"kind":"part","description":"Hopper"}]'::jsonb,'2026-06-04'::timestamptz,null,'1ZV56D262027006405','UPS',21.71,0,0,0,0,0,0,'house',false)
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
