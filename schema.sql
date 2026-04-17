-- makelila — Supabase schema
-- Paste into Supabase SQL editor for project txeftbbzeflequvrmjjr
-- Run in order. Safe to rerun (uses IF NOT EXISTS / CREATE OR REPLACE where possible).

-- ═══════════════════════════════════════════════════════════
-- 1. EXTENSIONS
-- ═══════════════════════════════════════════════════════════
create extension if not exists "uuid-ossp";
create extension if not exists "pg_cron";

-- ═══════════════════════════════════════════════════════════
-- 2. HELPER FUNCTIONS
-- ═══════════════════════════════════════════════════════════
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

-- ═══════════════════════════════════════════════════════════
-- 3. CORE TABLES
-- ═══════════════════════════════════════════════════════════

create table if not exists suppliers (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  contact_name text, email text, phone text,
  lead_time_days int default 14,
  min_order_qty int default 1,
  currency text default 'USD',
  payment_terms text, quality_rating numeric(3,1),
  on_time_delivery_pct numeric(5,2),
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);

create table if not exists products (
  id uuid primary key default uuid_generate_v4(),
  sku text unique not null,
  name text not null,
  category text,
  description text,
  selling_price numeric(12,2),
  currency text default 'CAD',
  unit_cost numeric(12,2),
  weight_kg numeric(8,3),
  dimensions text,
  shopify_product_id text,
  hubspot_product_id text,
  active boolean default true,
  reorder_point int default 0,
  reorder_qty int default 0,
  lead_time_days int default 14,
  min_order_qty int default 1,
  primary_supplier_id uuid references suppliers(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);

create table if not exists inventory_locations (
  id uuid primary key default uuid_generate_v4(),
  code text unique not null,
  name text not null,
  address text,
  location_type text check (location_type in ('primary','secondary','fulfillment')),
  created_at timestamptz default now()
);

create table if not exists inventory (
  id uuid primary key default uuid_generate_v4(),
  product_id uuid not null references products(id) on delete restrict,
  location_id uuid not null references inventory_locations(id) on delete restrict,
  on_hand_qty int default 0,
  committed_qty int default 0,
  expected_qty int default 0,
  safety_stock int default 0,
  batch_lot text,
  expiry_date date,
  last_count_at timestamptz,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (product_id, location_id, batch_lot)
);
create index if not exists idx_inventory_product on inventory(product_id);

create table if not exists customers (
  id uuid primary key default uuid_generate_v4(),
  external_customer_id text unique,     -- legacy 'CUST-###' from Excel for migration
  contact_name text,
  company_name text,
  email text,
  phone text,
  billing_address text,
  shipping_address text,
  shopify_customer_id text,
  hubspot_contact_id text,
  channel text default 'Shopify',
  payment_terms text,
  total_orders int default 0,           -- denormalized, refreshed by trigger or job
  total_revenue numeric(12,2) default 0,
  last_order_date date,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_customers_email on customers(email);
create index if not exists idx_customers_shopify on customers(shopify_customer_id);

create table if not exists sales_orders (
  id uuid primary key default uuid_generate_v4(),
  so_number text unique not null,
  order_date date not null default current_date,
  channel text default 'Shopify',
  channel_order_id text,
  customer_id uuid references customers(id),
  status text default 'Open' check (status in ('Draft','Open','In Progress','Shipped','Delivered','Cancelled')),
  payment_status text check (payment_status in ('Unpaid','Paid','Partially Paid','Refunded')),
  fulfillment_status text default 'Unfulfilled' check (fulfillment_status in ('Unfulfilled','Partial','Fulfilled')),
  warehouse_id uuid references inventory_locations(id),
  ship_by_date date,
  shipped_date date,
  tracking_number text,
  notes text,
  return_status text,
  rma_number text,
  return_reason text,
  -- Ashwini feedback #1: unified fulfillment (CA/US/Personal/Hold/Returns)
  region text check (region in ('CA','US','Personal','Hold','International')),
  -- Ashwini feedback #2: replacement tracking (first-class, was a notes column)
  replacement_batch text,
  replacement_serial_id uuid,
  replacement_reason text,
  -- Ashwini feedback #7: tie SO back to the campaign that drove it
  campaign_id uuid,
  total_amount numeric(12,2),
  currency text default 'USD',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_so_date on sales_orders(order_date desc);
create index if not exists idx_so_status on sales_orders(status);

create table if not exists sales_order_lines (
  id uuid primary key default uuid_generate_v4(),
  sales_order_id uuid not null references sales_orders(id) on delete cascade,
  product_id uuid not null references products(id),
  qty_ordered int not null,
  qty_shipped int default 0,
  unit_price numeric(12,2),
  line_total numeric(12,2) generated always as (qty_ordered * unit_price) stored,
  serial_number_id uuid,
  created_at timestamptz default now()
);
create index if not exists idx_sol_so on sales_order_lines(sales_order_id);

create table if not exists purchase_orders (
  id uuid primary key default uuid_generate_v4(),
  po_number text unique not null,
  po_date date default current_date,
  supplier_id uuid references suppliers(id),
  status text default 'Draft' check (status in ('Draft','Sent','Confirmed','Partially Received','Received','Invoiced','Closed','Cancelled')),
  expected_delivery date,
  actual_delivery date,
  payment_terms text,
  freight_cost numeric(12,2) default 0,
  invoice_number text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists purchase_order_lines (
  id uuid primary key default uuid_generate_v4(),
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  product_id uuid not null references products(id),
  qty_ordered int not null,
  qty_received int default 0,
  unit_cost numeric(12,2),
  line_total numeric(12,2) generated always as (qty_ordered * unit_cost) stored
);

create table if not exists make_orders (
  id uuid primary key default uuid_generate_v4(),
  mo_number text unique not null,
  product_id uuid not null references products(id),
  bom_version text,
  qty_to_make int not null,
  qty_completed int default 0,
  qty_scrap int default 0,
  status text default 'Planned' check (status in ('Planned','In Progress','Quality Check','Completed','On Hold','Cancelled')),
  priority text default 'Medium',
  created_date date default current_date,
  due_date date,
  start_date date,
  end_date date,
  assigned_to text,
  qa_approved_by uuid references auth.users(id),
  qa_approved_at timestamptz,
  linked_so_id uuid references sales_orders(id),
  warehouse_id uuid references inventory_locations(id),
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists boms (
  id uuid primary key default uuid_generate_v4(),
  bom_id text unique not null,
  product_id uuid not null references products(id),
  version text not null default 'v1.0',
  effective_date date default current_date,
  status text default 'Active',
  notes text,
  created_at timestamptz default now()
);

create table if not exists bom_components (
  id uuid primary key default uuid_generate_v4(),
  bom_id uuid not null references boms(id) on delete cascade,
  parent_component_id uuid references bom_components(id), -- multi-level self-ref
  component_product_id uuid not null references products(id),
  qty_per_unit numeric(10,3) not null default 1,
  uom text default 'EA',
  wastage_pct numeric(5,2) default 0,
  sequence int,
  notes text
);

create table if not exists shipments (
  id uuid primary key default uuid_generate_v4(),
  shipment_id text unique not null,
  sales_order_id uuid references sales_orders(id),
  ship_date date,
  carrier text,
  service_level text,
  origin_location_id uuid references inventory_locations(id),
  destination_address text,
  weight_kg numeric(8,3),
  dimensions text,
  status text default 'Pending' check (status in ('Pending','Label Created','In Transit','Out for Delivery','Delivered','Exception','Returned')),
  tracking_number text,
  freightcom_quote_id text,
  quoted_rate numeric(12,2),
  actual_cost numeric(12,2),
  est_delivery_date date,
  actual_delivery_date date,
  recipient_name text,
  recipient_phone text,
  delivery_signature text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists serial_numbers (
  id uuid primary key default uuid_generate_v4(),
  serial_number text unique not null,
  product_id uuid not null references products(id),
  batch_lot text,
  manufacture_date date,
  manufacture_mo_id uuid references make_orders(id),
  current_status text default 'In Inventory' check (current_status in ('In Inventory','In Production','Shipped','Returned','Scrapped')),
  current_location_id uuid references inventory_locations(id),
  current_customer_id uuid references customers(id),
  current_shipment_id uuid references shipments(id),
  warranty_months int default 24,
  warranty_expiry date, -- populated by trigger on ship
  -- Ashwini feedback #8: track firmware/software version per unit
  software_version text,  -- e.g. 'V15','V16','V17'
  on_dashboard boolean default false,  -- whether device is reporting to cloud dashboard
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_serial_customer on serial_numbers(current_customer_id);
create index if not exists idx_serial_batch on serial_numbers(batch_lot);

create table if not exists support_tickets (
  id uuid primary key default uuid_generate_v4(),
  hubspot_ticket_id text unique,
  subject text,
  pipeline_stage text, -- '1'=New, '2'=Waiting on cust, '3'=Waiting on us, '4'=Closed
  serial_number_id uuid references serial_numbers(id),
  customer_id uuid references customers(id),
  content text,
  hs_last_modified timestamptz,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists audit_log (
  id uuid primary key default uuid_generate_v4(),
  actor_user_id uuid references auth.users(id),
  table_name text not null,
  record_id uuid,
  action text check (action in ('INSERT','UPDATE','DELETE')),
  changed_at timestamptz default now(),
  old_values jsonb,
  new_values jsonb
);
create index if not exists idx_audit_table_record on audit_log(table_name, record_id);

-- ═══════════════════════════════════════════════════════════
-- 3b. EXTENSION TABLES (Ashwini feedback 2026-04-12)
-- ═══════════════════════════════════════════════════════════

-- #3 — Customer follow-up module (Ash's follow-up calendar consolidated)
create table if not exists customer_followups (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid not null references customers(id) on delete cascade,
  serial_number_id uuid references serial_numbers(id),
  ship_date date,
  onboarding_date date,
  followup_1_date date,
  followup_1_notes text,
  followup_2_date date,
  followup_2_notes text,
  compost_made boolean,
  review_submitted text check (review_submitted in ('Yes','No','Pending')),
  review_platform text,
  software_version text,
  on_dashboard boolean default false,
  action_item text,
  action_due_date date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_followup_customer on customer_followups(customer_id);

-- #4 — Team task escalation log (replaces Ash's "To Ask Team Members" tab)
create table if not exists team_tasks (
  id uuid primary key default uuid_generate_v4(),
  task_number text unique,                -- 'TASK-0001' etc
  date_raised date default current_date,
  raised_by uuid references auth.users(id),
  raised_by_name text,                    -- fallback when raiser isn't a system user
  assigned_to uuid references auth.users(id),
  assigned_to_name text,
  customer_id uuid references customers(id),
  sales_order_id uuid references sales_orders(id),
  description text not null,
  status text default 'Open' check (status in ('Open','In Progress','Resolved','Irrelevant')),
  reply_date date,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_team_tasks_status on team_tasks(status);

-- #5/#7 — Marketing campaigns (Pedrum's per-campaign files unified)
create table if not exists campaigns (
  id uuid primary key default uuid_generate_v4(),
  campaign_code text unique not null,     -- 'MAR-SALE-2026' etc
  name text not null,
  start_date date,
  end_date date,
  channel text,                           -- Meta / Google / Email / TikTok / other
  creative_version text,
  discount_code text,
  target_regions text[],                  -- {'CA','US'}
  buyers int default 0,
  revenue numeric(12,2) default 0,
  country_split jsonb,                    -- {"CA": 12, "US": 34}
  avg_order_value numeric(12,2),
  plan_breakdown jsonb,                   -- {"Outright": 20, "12mo": 14, "36mo": 6, "Sezzle": 3}
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- #6 — Repair tickets (replaces Junaid's text-message repair requests)
create table if not exists repair_tickets (
  id uuid primary key default uuid_generate_v4(),
  ticket_number text unique not null,     -- 'REP-0001' etc
  date_opened date default current_date,
  raised_by_name text,
  serial_number_id uuid references serial_numbers(id),
  customer_id uuid references customers(id),
  problem_description text,
  batch text,                             -- P50N / P100 / P150 (denormalized for quick filtering)
  repair_type text check (repair_type in ('Hardware','Software','Firmware','Other')),
  parts_needed text,
  status text default 'Open' check (status in ('Open','In Progress','Resolved','Scrapped')),
  date_resolved date,
  resolution_notes text,
  signed_off_by uuid references auth.users(id),
  signed_off_by_name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_repair_serial on repair_tickets(serial_number_id);
create index if not exists idx_repair_status on repair_tickets(status);

-- Deferred FKs for sales_orders → campaigns / replacement serial
alter table sales_orders
  drop constraint if exists fk_so_campaign,
  add constraint fk_so_campaign foreign key (campaign_id) references campaigns(id) on delete set null;
alter table sales_orders
  drop constraint if exists fk_so_replacement_serial,
  add constraint fk_so_replacement_serial foreign key (replacement_serial_id) references serial_numbers(id) on delete set null;

create table if not exists attachments (
  id uuid primary key default uuid_generate_v4(),
  table_name text not null,
  record_id uuid not null,
  storage_path text not null,
  mime_type text,
  uploaded_by uuid references auth.users(id),
  caption text,
  created_at timestamptz default now()
);

-- ═══════════════════════════════════════════════════════════
-- 4. VIEWS
-- ═══════════════════════════════════════════════════════════

create or replace view inventory_live as
select
  i.*,
  p.sku, p.name as product_name, p.category,
  p.reorder_point, p.reorder_qty, p.lead_time_days, p.unit_cost,
  loc.code as location_code, loc.name as location_name,
  (i.on_hand_qty - i.committed_qty) as available_qty,
  (i.on_hand_qty * p.unit_cost) as total_value,
  case
    when (i.on_hand_qty - i.committed_qty) <= 0 then 'OUT'
    when (i.on_hand_qty - i.committed_qty) <= p.reorder_point then 'LOW'
    else 'OK'
  end as stock_status,
  case
    when (i.on_hand_qty - i.committed_qty) <= 0 then 'ORDER NOW'
    when (i.on_hand_qty - i.committed_qty) <= p.reorder_point then 'REORDER'
    else 'OK'
  end as reorder_alert
from inventory i
join products p on p.id = i.product_id
left join inventory_locations loc on loc.id = i.location_id;

create or replace view sales_orders_enriched as
select
  so.*,
  c.contact_name as customer_name,
  c.email as customer_email,
  c.phone as customer_phone,
  loc.code as warehouse_code,
  (select sum(qty_ordered) from sales_order_lines where sales_order_id = so.id) as total_qty,
  (select string_agg(p.sku, ', ')
     from sales_order_lines sol join products p on p.id = sol.product_id
     where sol.sales_order_id = so.id) as skus
from sales_orders so
left join customers c on c.id = so.customer_id
left join inventory_locations loc on loc.id = so.warehouse_id;

create or replace view serial_tracker_full as
select
  sn.id, sn.serial_number, sn.batch_lot, sn.manufacture_date,
  sn.current_status, sn.warranty_expiry,
  p.sku, p.name as product_name,
  c.contact_name as customer_name, c.phone as customer_phone,
  s.ship_date, s.carrier, s.tracking_number, s.destination_address,
  s.shipment_id,
  t.hubspot_ticket_id, t.subject as ticket_subject, t.pipeline_stage
from serial_numbers sn
join products p on p.id = sn.product_id
left join customers c on c.id = sn.current_customer_id
left join shipments s on s.id = sn.current_shipment_id
left join support_tickets t on t.serial_number_id = sn.id;

-- Unified fulfillment view (Ashwini feedback #1): one source of truth for
-- Raymond & Aaron across CA / US / Personal / Hold / Returns.
create or replace view fulfillment_queue as
select
  so.id as sales_order_id,
  so.so_number,
  so.order_date,
  so.region,
  so.status,
  so.fulfillment_status,
  so.ship_by_date,
  so.shipped_date,
  so.tracking_number,
  so.return_status,
  so.rma_number,
  so.return_reason,
  so.replacement_batch,
  so.replacement_serial_id,
  so.replacement_reason,
  c.contact_name as customer_name,
  c.shipping_address,
  c.phone as customer_phone
from sales_orders so
left join customers c on c.id = so.customer_id
where so.status in ('Open','In Progress','Shipped')
   or so.return_status is not null
   or so.region = 'Hold';

-- Dashboard KPIs (materialized, refreshed by pg_cron)
create materialized view if not exists dashboard_kpis as
select
  (select count(*) from sales_orders where status = 'Open') as open_sales_orders,
  (select coalesce(sum(total_amount),0) from sales_orders where status = 'Open') as pending_revenue,
  (select count(*) from inventory_live where stock_status in ('LOW','OUT')) as low_stock_alerts,
  (select count(*) from purchase_orders where expected_delivery < current_date and status != 'Received') as overdue_pos,
  (select count(*) from serial_numbers where current_status = 'Shipped') as serials_in_field,
  (select count(*) from support_tickets where pipeline_stage != '4') as open_tickets,
  (select coalesce(sum(total_amount),0) from sales_orders
     where order_date >= current_date - 30 and status = 'Delivered') as revenue_30d,
  (select count(*) from shipments where status = 'In Transit') as shipments_in_transit,
  (select count(*) from sales_orders where order_date >= current_date - 30) as orders_30d,
  (select coalesce(sum(on_hand_qty * unit_cost),0) from inventory i
     join products p on p.id = i.product_id) as inventory_value,
  -- Ashwini feedback additions
  (select count(*) from team_tasks where status in ('Open','In Progress')) as open_team_tasks,
  (select count(*) from repair_tickets where status in ('Open','In Progress')) as open_repair_tickets,
  (select count(*) from customer_followups
     where action_due_date is not null and action_due_date <= current_date + 7) as followups_due_week,
  (select count(*) from campaigns where start_date <= current_date and end_date >= current_date) as active_campaigns,
  (select count(*) from shipments where (weight_kg is null or weight_kg = 0)) as shipments_missing_weight,
  now() as refreshed_at;

-- pg_cron: refresh KPIs every 5 minutes
-- select cron.schedule('refresh-kpis','*/5 * * * *','refresh materialized view dashboard_kpis');

-- ═══════════════════════════════════════════════════════════
-- 5. RECURSIVE BOM EXPLODE FUNCTION
-- ═══════════════════════════════════════════════════════════
create or replace function fn_explode_bom(p_product_id uuid, p_qty numeric default 1)
returns table (
  level int,
  parent_sku text,
  component_sku text,
  component_name text,
  qty_required numeric,
  unit_cost numeric,
  extended_cost numeric
) language sql as $$
  with recursive bom_tree as (
    -- anchor: top-level components of the product's active BOM
    select 1 as level, p.sku as parent_sku,
           cp.sku as component_sku, cp.name as component_name,
           bc.qty_per_unit * p_qty * (1 + coalesce(bc.wastage_pct,0)/100) as qty_required,
           cp.unit_cost,
           cp.unit_cost * bc.qty_per_unit * p_qty * (1 + coalesce(bc.wastage_pct,0)/100) as extended_cost,
           bc.component_product_id
    from boms b
    join bom_components bc on bc.bom_id = b.id
    join products p on p.id = b.product_id
    join products cp on cp.id = bc.component_product_id
    where b.product_id = p_product_id and b.status = 'Active'
    union all
    -- recurse: explode any sub-assembly that itself has an active BOM
    select bt.level + 1, bt.component_sku,
           cp2.sku, cp2.name,
           bc2.qty_per_unit * bt.qty_required * (1 + coalesce(bc2.wastage_pct,0)/100),
           cp2.unit_cost,
           cp2.unit_cost * bc2.qty_per_unit * bt.qty_required * (1 + coalesce(bc2.wastage_pct,0)/100),
           bc2.component_product_id
    from bom_tree bt
    join boms b2 on b2.product_id = bt.component_product_id and b2.status = 'Active'
    join bom_components bc2 on bc2.bom_id = b2.id
    join products cp2 on cp2.id = bc2.component_product_id
  )
  select level, parent_sku, component_sku, component_name,
         qty_required, unit_cost, extended_cost
  from bom_tree
  order by level, parent_sku, component_sku;
$$;

-- ═══════════════════════════════════════════════════════════
-- 6. TRIGGERS: updated_at on every mutable table
-- ═══════════════════════════════════════════════════════════
do $$
declare t text;
begin
  for t in select unnest(array[
    'suppliers','products','inventory','customers','sales_orders',
    'purchase_orders','make_orders','shipments','serial_numbers','support_tickets',
    'customer_followups','team_tasks','campaigns','repair_tickets'
  ]) loop
    execute format(
      'drop trigger if exists trg_updated_at on %I; create trigger trg_updated_at before update on %I for each row execute function set_updated_at();',
      t, t);
  end loop;
end $$;

-- Warranty expiry: populate on serial ship
create or replace function fn_set_warranty_expiry() returns trigger as $$
begin
  if new.current_status = 'Shipped' and new.current_shipment_id is not null and new.warranty_expiry is null then
    new.warranty_expiry := (
      select s.ship_date + (new.warranty_months || ' months')::interval
      from shipments s where s.id = new.current_shipment_id
    )::date;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_serial_warranty on serial_numbers;
create trigger trg_serial_warranty
  before insert or update on serial_numbers
  for each row execute function fn_set_warranty_expiry();

-- ═══════════════════════════════════════════════════════════
-- 7. ROW-LEVEL SECURITY (single-tenant)
-- ═══════════════════════════════════════════════════════════
-- Enable RLS on all tables. Policies assume `role` claim in JWT.
do $$
declare t text;
begin
  for t in select unnest(array[
    'suppliers','products','inventory_locations','inventory','customers',
    'sales_orders','sales_order_lines','purchase_orders','purchase_order_lines',
    'make_orders','boms','bom_components','shipments','serial_numbers',
    'support_tickets','audit_log','attachments',
    'customer_followups','team_tasks','campaigns','repair_tickets'
  ]) loop
    execute format('alter table %I enable row level security;', t);
    execute format(
      'drop policy if exists "auth_read" on %I; create policy "auth_read" on %I for select to authenticated using (true);',
      t, t);
    execute format(
      'drop policy if exists "staff_write" on %I; create policy "staff_write" on %I for all to authenticated using (coalesce((auth.jwt() -> ''app_metadata'' ->> ''role''), ''viewer'') in (''admin'',''staff'',''warehouse'')) with check (coalesce((auth.jwt() -> ''app_metadata'' ->> ''role''), ''viewer'') in (''admin'',''staff'',''warehouse''));',
      t, t);
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════
-- 8. SEED DATA — real data extracted from Virgo_Operations_Hub_MRP.xlsx
-- Comment out in prod. Customer/SO/serial seeds live in seeds.sql (50 rows each).
-- ═══════════════════════════════════════════════════════════
insert into inventory_locations (code, name, address, location_type) values
  ('Toronto-01',   'VirgoHome HQ (Toronto)',  '50 Industrial Blvd, Scarborough ON', 'primary'),
  ('Vancouver-01', 'Vancouver Distribution',  '120 Port Rd, Richmond BC',           'secondary'),
  ('Calgary-01',   'Calgary Fulfillment',     '80 Logistics Ave, Calgary AB',       'fulfillment')
on conflict (code) do nothing;

-- Suppliers (from Products!Primary Supplier + Vendors & POs!Vendor Name)
insert into suppliers (name, contact_name, email, lead_time_days, currency, payment_terms, quality_rating) values
  ('ShenZhen Electronics Co',  'Li Wei',       'li@szelectronics.cn',   14, 'USD', 'Net 30', 4.5),
  ('OptiLens Taiwan',          'Chen Yu',      'chen@optilens.tw',      21, 'USD', 'Net 45', 4.2),
  ('Canadian Plastics Inc',    'Marie Dupont', 'marie@canplastics.ca',   7, 'CAD', 'Net 30', 4.0),
  ('BatteryWorld Ltd',         'James Park',   'james@battworld.com',   10, 'USD', 'Net 30', 3.8),
  ('ThermoComp GmbH',          'Klaus Müller', 'klaus@thermocomp.de',   13, 'EUR', 'Net 60', 4.7),
  ('LockTech Shenzhen',         null,           null,                   18, 'USD', 'Net 30', null),
  ('Factory-CN (LILA)',         null,           null,                   60, 'USD', 'Net 45', null)
on conflict do nothing;

-- Products (VH-100 through VH-500 smart-home line + LILA-001 composter)
insert into products (sku, name, category, description, selling_price, currency, unit_cost, reorder_point, reorder_qty, lead_time_days, min_order_qty, weight_kg, dimensions, primary_supplier_id) values
  ('LILA-001','LILA Composter','Composter','Kitchen electric composter',              1049.00,'USD', null,  20, 100, 60, 10, 8.00, '45x35x30',
     (select id from suppliers where name='Factory-CN (LILA)')),
  ('VH-100','Virgo Smart Hub','Smart Home','Central smart home hub WiFi/Zigbee/Z-Wave', 490.00,'CAD', 43.95, 25,  50, 14, 10, 0.45, '15x12x5',
     (select id from suppliers where name='ShenZhen Electronics Co')),
  ('VH-200','Virgo Motion Sensor','Sensors','PIR motion sensor w/ temp/humidity',       65.00,'CAD', 32.00, 50, 100, 10, 25, 0.08, '8x5x3',
     (select id from suppliers where name='ShenZhen Electronics Co')),
  ('VH-300','Virgo Security Cam','Security','1080p outdoor camera, night vision',      890.00,'CAD', 58.70, 30,  30, 21,  5, 0.35, '12x10x8',
     (select id from suppliers where name='OptiLens Taiwan')),
  ('VH-400','Virgo Door Lock','Access','Smart deadbolt w/ fingerprint, keypad',        650.00,'CAD', 95.00, 20,  25, 18,  5, 0.95, '20x8x6',
     (select id from suppliers where name='LockTech Shenzhen')),
  ('VH-500','Virgo Thermostat','Climate','Smart thermostat w/ learning schedule',      280.00,'CAD', 68.00, 25,  50, 12, 10, 0.18, '12x12x3',
     (select id from suppliers where name='ShenZhen Electronics Co'))
on conflict (sku) do nothing;

-- Inventory snapshot (6 rows: VH-series across Toronto + Vancouver)
insert into inventory (product_id, location_id, on_hand_qty, committed_qty, expected_qty, batch_lot)
select p.id, l.id, x.oh, x.cm, x.exp, x.lot
from (values
  ('VH-100','Toronto-01',   150,  7, 50, 'LOT-2026-041'),
  ('VH-200','Toronto-01',   320, 13,100, 'LOT-2026-038'),
  ('VH-300','Toronto-01',    80, 10,  0, 'LOT-2026-035'),
  ('VH-400','Toronto-01',    45,  8, 25, 'LOT-2026-040'),
  ('VH-100','Vancouver-01',  60,  2,  0, 'LOT-2026-039'),
  ('VH-500','Toronto-01',    10,  0, 50, 'LOT-2026-042')
) as x(sku, loc, oh, cm, exp, lot)
join products p on p.sku = x.sku
join inventory_locations l on l.code = x.loc
on conflict (product_id, location_id, batch_lot) do nothing;
