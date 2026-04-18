insert into public.orders (
  order_ref, status, customer_name, customer_email, customer_phone, quo_thread_url,
  address_line, city, region_state, country, address_verdict,
  freight_estimate_usd, freight_threshold_usd,
  total_usd, line_items
) values
  ('#3847', 'pending', 'Keith Taitano', 'keith.taitano@gmail.com', '+15035550101',
   'https://my.quo.com/inbox/PNY7S3rMek',
   '2847 SW Corbett Ave', 'Portland', 'OR', 'US', 'house',
   89.50, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb),

  ('#3848', 'pending', 'Marianne Chen', 'marianne.chen@protonmail.com', '+16042225599',
   null,
   '1050 Burrard St #2201', 'Vancouver', 'BC', 'CA', 'apt',
   115.00, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb),

  ('#3849', 'pending', 'Raymond Park', 'ray.park@hotmail.com', '+14168904412',
   null,
   '88 Scott St #3106', 'Toronto', 'ON', 'CA', 'condo',
   135.00, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb),

  ('#3850', 'pending', 'Ashley Brooks', 'abrooks@yahoo.com', '+12069991112',
   null,
   '415 1st Ave N', 'Seattle', 'WA', 'US', 'house',
   95.00, 200.00, 2298.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":2,"price_usd":1149.00}]'::jsonb),

  ('#3851', 'pending', 'Gordon Huang', 'gordon.h@icloud.com', '+14155550123',
   'https://my.quo.com/inbox/QH81MRZtxC',
   '2150 Lombard St', 'San Francisco', 'CA', 'US', 'house',
   105.00, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb),

  ('#3852', 'pending', 'Nora Bélanger', 'nora.belanger@videotron.ca', '+15145551234',
   null,
   '1234 Rue Sherbrooke O', 'Montréal', 'QC', 'CA', 'house',
   125.00, 200.00, 1244.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00},{"sku":"LL-ACC-01","name":"Starter soil kit","qty":1,"price_usd":95.00}]'::jsonb),

  ('#3845', 'flagged', 'Derek Sloan', 'dsloan@example.com', '+19075550000',
   null,
   'Mile 63 Haul Rd', 'Coldfoot', 'AK', 'US', 'remote',
   275.00, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb),

  ('#3846', 'held', 'Melanie Ortiz', 'm.ortiz@outlook.com', '+13055550189',
   null,
   '845 Collins Ave', 'Miami Beach', 'FL', 'US', 'apt',
   150.00, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb)
on conflict (order_ref) do nothing;
