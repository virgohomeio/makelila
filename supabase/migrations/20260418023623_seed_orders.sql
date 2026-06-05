insert into public.orders (
  order_ref, status, customer_name, customer_email, customer_phone, quo_thread_url,
  address_line, city, region_state, country, address_verdict,
  freight_estimate_usd, freight_threshold_usd,
  total_usd, line_items
) values
  ('#3847', 'pending', 'Marlow Lund', 'customer26@example.com', '555-0130-0000',
   'https://my.quo.com/inbox/PNY7S3rMek',
   '261 Example St', 'Portland', 'OR', 'US', 'house',
   89.50, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb),

  ('#3848', 'pending', 'Nico Mott', 'customer27@example.com', '555-0131-0000',
   null,
   '268 Example St', 'Vancouver', 'BC', 'CA', 'apt',
   115.00, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb),

  ('#3849', 'pending', 'Onyx Noble', 'customer28@example.com', '555-0132-0000',
   null,
   '275 Example St', 'Toronto', 'ON', 'CA', 'condo',
   135.00, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb),

  ('#3850', 'pending', 'Avery Archer', 'customer29@example.com', '555-0133-0000',
   null,
   '282 Example St', 'Seattle', 'WA', 'US', 'house',
   95.00, 200.00, 2298.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":2,"price_usd":1149.00}]'::jsonb),

  ('#3851', 'pending', 'Blake Brooks', 'customer30@example.com', '555-0134-0000',
   'https://my.quo.com/inbox/QH81MRZtxC',
   '289 Example St', 'San Francisco', 'CA', 'US', 'house',
   105.00, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb),

  ('#3852', 'pending', 'Casey Carver', 'customer31@example.com', '555-0135-0000',
   null,
   '296 Example St', 'Montréal', 'QC', 'CA', 'house',
   125.00, 200.00, 1244.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00},{"sku":"LL-ACC-01","name":"Starter soil kit","qty":1,"price_usd":95.00}]'::jsonb),

  ('#3845', 'flagged', 'Drew Dunn', 'dsloan@example.com', '555-0136-0000',
   null,
   '303 Example St', 'Coldfoot', 'AK', 'US', 'remote',
   275.00, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb),

  ('#3846', 'held', 'Emerson Ellis', 'customer32@example.com', '555-0137-0000',
   null,
   '310 Example St', 'Miami Beach', 'FL', 'US', 'apt',
   150.00, 200.00, 1149.00,
   '[{"sku":"LL01-2025","name":"Lila 01 — 2025 edition","qty":1,"price_usd":1149.00}]'::jsonb)
on conflict (order_ref) do nothing;
