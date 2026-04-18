-- Reseed down to 6 orders with a targeted info-completeness + status spread.
-- See docs/2026-04-17-make-lila-order-review-design.md for the schema.
-- Demo spread: 3 complete pending (confirm), 1 partial pending (need-info),
-- 1 flagged, 1 held.
delete from public.orders;

insert into public.orders (
  order_ref, status, customer_name, customer_email, customer_phone, quo_thread_url,
  address_line, city, region_state, country, address_verdict,
  freight_estimate_usd, freight_threshold_usd,
  total_usd, line_items
) values
  -- PENDING · complete info · to confirm
  ('#1107', 'pending', 'Louis DiPalma', 'ljdpdm@me.com', '+13039199498',
   'https://my.quo.com/inbox/LD4K5L6mN7',
   '1285 Pelham Rd', 'New Rochelle', 'NY', 'US', 'house',
   105.00, 200.00, 1043.06,
   '[{"sku":"LILA-001","name":"LILA Pro","qty":1,"price_usd":1043.06}]'::jsonb),

  ('#1093', 'pending', 'Brent Neave', 'b.neave@shaw.ca', '+16043292421',
   'https://my.quo.com/inbox/bNvE8O9p0Q',
   '214 50 Avenue SW', 'Rocky Mountain House', 'AB', 'CA', 'house',
   165.00, 200.00, 1396.49,
   '[{"sku":"LILA-001","name":"LILA Pro","qty":1,"price_usd":1396.49}]'::jsonb),

  ('#1110', 'pending', 'Phayvanh Nanthavongdouangsy', 'phayvanh.n@gmail.com', '+19514470231',
   'https://my.quo.com/inbox/phVn5B6c7D',
   '3401 Market St #407', 'Riverside', 'CA', 'US', 'apt',
   115.00, 200.00, 1016.36,
   '[{"sku":"LILA-001","name":"LILA Pro","qty":1,"price_usd":1016.36}]'::jsonb),

  -- PENDING · partial info · to Need Info
  ('#1111', 'pending', 'Annmarie Kennedy', null, null,
   'https://my.quo.com/inbox/k1n2dy3A4k',
   null, 'Seymour', 'CT', 'US', 'house',
   89.00, 200.00, 1037.27,
   '[{"sku":"LILA-001","name":"LILA Pro","qty":1,"price_usd":1037.27}]'::jsonb),

  -- FLAGGED · partial info · over freight threshold
  ('#1097', 'flagged', 'Cole Perkins', null, '+16199167732',
   'https://my.quo.com/inbox/cPrk1R2sT3',
   null, 'Oshawa', 'ON', 'CA', 'remote',
   275.00, 200.00, 1372.36,
   '[{"sku":"LILA-001","name":"LILA Pro","qty":1,"price_usd":1372.36}]'::jsonb),

  -- HELD · partial info · apartment delivery
  ('#1070', 'held', 'Ron Russell', null, '+16048344451',
   'https://my.quo.com/inbox/RrSl4U5vW6',
   null, 'Sooke', 'BC', 'CA', 'apt',
   145.00, 200.00, 1049.99,
   '[{"sku":"LILA-001","name":"LILA Pro","qty":1,"price_usd":1049.99}]'::jsonb);
