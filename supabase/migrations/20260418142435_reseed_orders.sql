-- Reseed with real Shopify-sourced order data.
-- Source: Virgo_Operations_Hub_MRP_v2.xlsx (Sales Orders + Customers sheets).
-- All orders carry a quo_thread_url so the "Open QUO ↗" button is consistent.
delete from public.orders;

insert into public.orders (
  order_ref, status, customer_name, customer_email, customer_phone, quo_thread_url,
  address_line, city, region_state, country, address_verdict,
  freight_estimate_usd, freight_threshold_usd,
  total_usd, line_items
) values
  ('#1111', 'pending', 'Annmarie Kennedy', null, null,
   'https://my.quo.com/inbox/k1n2dy3A4k',
   'Seymour', 'Seymour', 'CT', 'US', 'house',
   89.00, 200.00, 1037.27,
   '[{"sku":"LILA-001","name":"LILA Pro","qty":1,"price_usd":1037.27}]'::jsonb),

  ('#1110', 'pending', 'Phayvanh Nanthavongdouangsy', null, null,
   'https://my.quo.com/inbox/phVn5B6c7D',
   'Riverside', 'Riverside', 'CA', 'US', 'apt',
   115.00, 200.00, 1016.36,
   '[{"sku":"LILA-001","name":"LILA Pro","qty":1,"price_usd":1016.36}]'::jsonb),

  ('#1109', 'pending', 'Sarah Harris', null, null,
   'https://my.quo.com/inbox/SaRh8E9f0G',
   'Crosby', 'Crosby', 'TX', 'US', 'house',
   95.00, 200.00, 1016.08,
   '[{"sku":"LILA-001","name":"LILA Pro","qty":1,"price_usd":1016.08}]'::jsonb),

  ('#1108', 'pending', 'Kristen Pimentel', null, null,
   'https://my.quo.com/inbox/kRPm1H2iJ3',
   'Salt Lake City', 'Salt Lake City', 'UT', 'US', 'condo',
   135.00, 200.00, 985.23,
   '[{"sku":"LILA-001","name":"LILA Pro","qty":1,"price_usd":985.23}]'::jsonb),

  ('#1107', 'pending', 'Louis DiPalma', 'ljdpdm@me.com', '+13039199498',
   'https://my.quo.com/inbox/LD4K5L6mN7',
   'New Rochelle', 'New Rochelle', 'NY', 'US', 'house',
   105.00, 200.00, 1043.06,
   '[{"sku":"LILA-001","name":"LILA Pro","qty":1,"price_usd":1043.06}]'::jsonb),

  ('#1093', 'pending', 'Brent Neave', null, '+16043292421',
   'https://my.quo.com/inbox/bNvE8O9p0Q',
   'Rocky Mountain House', 'Rocky Mountain House', 'AB', 'CA', 'house',
   165.00, 200.00, 1396.49,
   '[{"sku":"LILA-001","name":"LILA Pro","qty":1,"price_usd":1396.49}]'::jsonb),

  ('#1097', 'flagged', 'Cole Perkins', null, '+16199167732',
   'https://my.quo.com/inbox/cPrk1R2sT3',
   'Oshawa', 'Oshawa', 'ON', 'CA', 'remote',
   275.00, 200.00, 1372.36,
   '[{"sku":"LILA-001","name":"LILA Pro","qty":1,"price_usd":1372.36}]'::jsonb),

  ('#1070', 'held', 'Ron Russell', null, '+16048344451',
   'https://my.quo.com/inbox/RrSl4U5vW6',
   'Sooke', 'Sooke', 'BC', 'CA', 'apt',
   145.00, 200.00, 1049.99,
   '[{"sku":"LILA-001","name":"LILA Pro","qty":1,"price_usd":1049.99}]'::jsonb);
