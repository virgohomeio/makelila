-- Apply the 2026-04-20 inventory-status.md snapshot onto public.units.
--
-- Source: customer-facing md file combining Virgo Operations Hub MRP, MaxxUs
-- shipping log, Canada Fulfillment sheet, P150 Fulfillment CSV, and Returns
-- Log. For each serial explicitly mentioned we capture the *latest* customer
-- assignment (i.e. if a defective unit was replaced, the serial tracks the
-- refurb path since the physical unit has one serial).
--
-- Fields applied per serial: batch (may differ from earlier seed assumption),
-- status, customer_name, location (province/state), carrier, and a note.
-- Original-customer-returned P50 serials where the unit was pulled and
-- replaced are marked 'scrap' (physical unit no longer in circulation).

-- Step 1. Reset P50N default to 'ready' (on shelf). The earlier seed
--         guessed "mostly shipped" — the snapshot says ~36 are still on
--         the shelf and only 4 have shipped. We'll mark the 4 shipped
--         individually below.
update public.units
set status = 'ready',
    customer_name = null, carrier = null, location = null,
    notes = 'On shelf at Toronto warehouse (P50N).'
where batch = 'P50N';

-- Step 2. Reset P150 to 'ready' for all so the mass update below can promote
--         known-shipped serials. The ~50 defectives that aren't explicitly
--         listed will stay 'ready' here — they can be flipped to 'scrap' via
--         the Stock UI once specific serials are identified.
update public.units
set status = 'ready',
    customer_name = null, carrier = null, location = null,
    notes = 'On shelf at Toronto warehouse (P150).'
where batch = 'P150';

-- Step 3. Big mass-update from the snapshot.
update public.units u set
  batch         = v.batch,
  status        = v.status::text,
  customer_name = nullif(v.customer_name, ''),
  location      = nullif(v.location, ''),
  carrier       = nullif(v.carrier, ''),
  notes         = v.notes
from (values
  -- -------------------- P50 VIP First 35 (May 2025 deliveries) --------------------
  ('LL01-00000000001', 'P50',  'shipped', 'Joe Lu',                     'ON',  '',         'P50 VIP · delivered 2025-05-20'),
  ('LL01-00000000003', 'P50',  'shipped', 'Billy Wu',                   'ON',  '',         'P50 VIP · delivered 2025-05-14'),
  ('LL01-00000000006', 'P50',  'shipped', 'Rongbin Sun',                'ON',  '',         'P50 VIP · delivered 2025-05-06 (unit 1, Kevin receiver)'),
  ('LL01-00000000009', 'P50',  'shipped', 'Jenny Pho',                  'ON',  '',         'P50 VIP · delivered 2025-05-14'),
  ('LL01-00000000011', 'P50',  'shipped', 'Jeff Peng',                  'ON',  '',         'P50 VIP · delivered 2025-05-27 (not paid)'),
  ('LL01-00000000012', 'P50',  'shipped', 'Ellery Bunn',                'ON',  '',         'P50 VIP · delivered 2025-05-10 (later replaced by 110)'),
  ('LL01-00000000015', 'P50',  'shipped', 'Mike Ferragina',             'ON',  '',         'P50 VIP · delivered 2025-05-27'),
  ('LL01-00000000020', 'P50',  'shipped', 'Junguo Liao',                'ON',  '',         'P50 VIP · delivered 2025-05-02'),
  ('LL01-00000000022', 'P50',  'shipped', 'Chris Birtch',               'ON',  '',         'P50 VIP · delivered 2025-05-17'),
  ('LL01-00000000024', 'P50',  'shipped', 'Rongbin Sun',                'ON',  '',         'P50 VIP · delivered 2025-05-06 (unit 2)'),
  ('LL01-00000000028', 'P50',  'shipped', 'David Forster',              'ON',  '',         'P50 VIP · delivered 2025-05-17 (swapped from 019)'),
  ('LL01-00000000029', 'P50',  'shipped', 'Chris Phillips',             'ON',  '',         'P50 VIP · shipped, not delivered'),
  ('LL01-00000000030', 'P50',  'shipped', 'Tony Wang',                  'ON',  '',         'P50 VIP · delivered 2025-05-06'),
  ('LL01-00000000031', 'P50',  'shipped', 'Yun Feng Zhang',             'ON',  '',         'P50 VIP · delivered 2025-05-07'),
  ('LL01-00000000036', 'P50',  'shipped', 'Bryan Ho (Dan Tran)',        'ON',  '',         'P50 VIP · delivered 2025-05-08'),
  ('LL01-00000000038', 'P50',  'shipped', 'Kelley Gonsalves',           'ON',  '',         'P50 VIP · delivered 2025-05-13'),
  ('LL01-00000000039', 'P50',  'shipped', 'Kevin Cheng',                'ON',  '',         'P50 VIP · delivered 2025-05-12'),
  ('LL01-00000000040', 'P50',  'shipped', 'Tien Tran',                  'ON',  '',         'P50 VIP · delivered 2025-05-08'),

  -- Original P50 units that were returned and replaced via MaxxUs batch (physical unit out of circulation)
  ('LL01-00000000008', 'P50',  'scrap',   'Brian Fryer (original)',     '',    '',         'P50 VIP 2025-05-10 shipped not delivered; replaced by 107.'),
  ('LL01-00000000013', 'P50',  'scrap',   'Doug Bailey (original)',     '',    '',         'P50 VIP 2025-05-17; replaced by 016 via MaxxUs.'),
  ('LL01-00000000027', 'P50',  'scrap',   'Phil Parkinson (original)',  '',    '',         'P50 VIP 2025-05-09; replaced by 060 via MaxxUs.'),
  ('LL01-00000000032', 'P50',  'scrap',   'Washington (original)',      '',    '',         'P50 VIP 2025-05-03; replaced by 049 via MaxxUs.'),
  ('LL01-00000000034', 'P50',  'scrap',   'McMaurice (original)',       '',    '',         'P50 VIP 2025-05-15; replaced by 075 via MaxxUs.'),
  ('LL01-00000000037', 'P50',  'scrap',   'Caesar Radicioni (original)','',    '',         'P50 VIP 2025-05-09; replaced by 063 via MaxxUs.'),
  ('LL01-00000000041', 'P50',  'scrap',   'Ted Dochau (original)',      '',    '',         'P50 VIP 2025-05-15; reassigned to 004.'),

  -- -------------------- MaxxUs (Oct 2025 – Jan 2026) --------------------
  -- Either new deliveries OR replacements for defective P50 VIP units.
  ('LL01-00000000004', 'P50',  'shipped', 'Sharon Corcoran',            'ON',  'Canpar',   'MaxxUs replacement · received 2025-11-11 (refurb path: Thao→Ted→Sharon)'),
  ('LL01-00000000007', 'P50',  'shipped', 'Melissa Braschuk',           'ON',  'Purolator','MaxxUs · received 2026-01-08'),
  ('LL01-00000000016', 'P50',  'shipped', 'Doug Bailey',                'ON',  'Canpar',   'MaxxUs replacement · received 2025-11-06'),
  ('LL01-00000000017', 'P50',  'shipped', 'Michael Madigan',            'ON',  'Canpar',   'MaxxUs replacement · received 2025-11-06'),
  ('LL01-00000000019', 'P50',  'shipped', 'Matthew Lypkie',             'ON',  'Canpar',   'MaxxUs · received 2026-01-06'),
  ('LL01-00000000021', 'P50',  'shipped', 'Don Saldana',                'ON',  'Canpar',   'MaxxUs · received 2026-01-22'),
  ('LL01-00000000023', 'P50',  'shipped', 'Shelley M Small',            'ON',  'Fedex',    'MaxxUs replacement · received 2026-01-07 (RTN-0027 shipping damage)'),
  ('LL01-00000000025', 'P50',  'shipped', 'Matthew Mossey',             'ON',  'Canpar',   'MaxxUs replacement · received 2026-01-14'),
  ('LL01-00000000026', 'P50',  'shipped', 'Steven Yang',                'ON',  'Canpar',   'MaxxUs · received 2025-10-22'),
  ('LL01-00000000033', 'P50',  'shipped', 'David Foster',               'ON',  'Canpar',   'MaxxUs · received 2025-10-22 (refurb path from Salvatore De Cillis)'),
  ('LL01-00000000043', 'P50',  'shipped', 'Sharai Mustatia',            'ON',  'Canpar',   'MaxxUs · received 2026-01-15 (RTN-0024 shipping damage)'),
  ('LL01-00000000044', 'P50',  'shipped', 'Jeff Mottle',                'ON',  'Canpar',   'MaxxUs · received 2026-01-27'),
  ('LL01-00000000049', 'P50',  'shipped', 'Jill & James Washington',    'ON',  'Canpar',   'MaxxUs replacement · received 2025-12-03'),
  ('LL01-00000000050', 'P50',  'shipped', 'Jenifer Henry',              'ON',  'Purolator','MaxxUs · received 2026-01-23'),
  ('LL01-00000000060', 'P50',  'shipped', 'Phil Parkinson',             'ON',  'Canpar',   'MaxxUs replacement · received 2025-10-22'),
  ('LL01-00000000063', 'P150', 'shipped', 'Caesar Radicioni',           'ON',  'Canpar',   'MaxxUs replacement (black) · received 2025-10-22'),
  ('LL01-00000000067', 'P150', 'shipped', 'Alp Celebi',                 'ON',  'Canpar',   'MaxxUs (black) · received 2025-11-07'),
  ('LL01-00000000071', 'P150', 'shipped', 'Joan Teichroeb',             'BC',  'Canpar',   'MaxxUs (black) · received 2026-02-03'),
  ('LL01-00000000073', 'P150', 'shipped', 'Tony Rinello',               'ON',  'Canpar',   'MaxxUs (black) · received 2025-10-30'),
  ('LL01-00000000075', 'P150', 'shipped', 'Caroline & Mike McMaurice',  'ON',  'Canpar',   'MaxxUs replacement (black) · received 2025-11-11'),
  ('LL01-00000000076', 'P150', 'shipped', 'Chris & Renata Grant',       'ON',  'Canpar',   'MaxxUs (black) · received 2025-11-10'),
  ('LL01-00000000077', 'P150', 'shipped', 'Jim Christie',               'ON',  'Canpar',   'MaxxUs (black) · received 2025-10-29'),
  ('LL01-00000000082', 'P150', 'shipped', 'Michael Haywood',            'ON',  'Canpar',   'MaxxUs (black) · received 2025-10-29'),
  ('LL01-00000000083', 'P150', 'shipped', 'Karen Shorey',               'ON',  'Canpar',   'MaxxUs (black) · received 2026-01-27'),
  ('LL01-00000000099', 'P150', 'shipped', 'Vicki Crooke',               'ON',  'Canpar',   'MaxxUs (black) · received 2025-11-06'),
  ('LL01-00000000101', 'P150', 'shipped', 'Omniya Hussein',             'ON',  'Canpar',   'MaxxUs (black) · received 2025-11-10'),
  ('LL01-00000000107', 'P150', 'shipped', 'Brian Fryer',                'ON',  'Canpar',   'MaxxUs replacement · received 2025-10-22'),
  ('LL01-00000000108', 'P150', 'shipped', 'Scott Destephanis',          'ON',  'Canpar',   'MaxxUs (black) · received 2025-10-30 (RTN-0016 software issue)'),
  ('LL01-00000000109', 'P150', 'shipped', 'Joan Teichroeb',             'BC',  'Canpar',   'Canada Fulfillment · received 2026-03-30 (3rd replacement)'),
  ('LL01-00000000110', 'P150', 'shipped', 'Ellery Bunn',                'ON',  'Canpar',   'MaxxUs replacement · received 2025-10-22'),
  ('LL01-00000000112', 'P150', 'shipped', 'Elizabeth Antony',           'ON',  'Canpar',   'MaxxUs · received 2026-01-17'),
  ('LL01-00000000115', 'P150', 'shipped', 'Angeline Purcell',           'ON',  'Canpar',   'MaxxUs · received 2026-02-02'),
  ('LL01-00000000116', 'P150', 'shipped', 'Lynn Liu',                   'ON',  'Canpar',   'MaxxUs · received 2025-11-05'),
  ('LL01-00000000117', 'P150', 'shipped', 'Daniel Chevalier',           'ON',  'Canpar',   'MaxxUs (black) · received 2026-01-27 (Jamie Smyth original, reassigned)'),
  ('LL01-00000000119', 'P150', 'shipped', 'Olivia Amaro',               'ON',  'GLS',      'MaxxUs (black) · received 2025-10-30'),
  ('LL01-00000000122', 'P150', 'shipped', 'Scott Gilbert',              'AB',  'Canpar',   'Canada Fulfillment · received 2026-03-11'),
  ('LL01-00000000126', 'P150', 'shipped', 'Vicki Myhre',                'AB',  'Canpar',   'Canada Fulfillment · received 2026-02-24'),
  ('LL01-00000000127', 'P150', 'shipped', 'Kelly Dyment',               'ON',  'Canpar',   'MaxxUs (black) · received 2025-11-05'),
  ('LL01-00000000133', 'P150', 'shipped', 'Albert & Vincenza Salvatore','ON',  'Canpar',   'MaxxUs (black) · received 2025-11-06'),
  ('LL01-00000000136', 'P150', 'shipped', 'Mary & Marilynne Oskamp',    'ON',  'Canpar',   'MaxxUs (black) · received 2025-10-30'),
  ('LL01-00000000137', 'P150', 'shipped', 'Yuanbo Luo',                 'ON',  'Canpar',   'MaxxUs · received 2025-11-11'),
  ('LL01-00000000141', 'P150', 'shipped', 'Tamara Martin',              'ON',  'Canpar',   'MaxxUs · received 2026-01-10'),
  ('LL01-00000000142', 'P150', 'shipped', 'Joy Seargeant',              'ON',  'Canpar',   'Canada Fulfillment · received 2026-03-30'),
  ('LL01-00000000144', 'P150', 'shipped', 'Robert Simoneau',            'QC',  'Canpar',   'Canada Fulfillment · received 2026-02-26'),
  ('LL01-00000000145', 'P150', 'shipped', 'Amanda McCordic',            'NB',  'UPS',      'Canada Fulfillment · received 2026-02-04'),
  ('LL01-00000000146', 'P150', 'shipped', 'Salvatore DeCillis & Julia', 'ON',  'Canpar',   'MaxxUs · received 2025-11-11'),
  ('LL01-00000000147', 'P150', 'shipped', 'Annie Wu',                   'ON',  'Canpar',   'MaxxUs (black) · received 2025-10-22'),

  -- -------------------- P150 US shipments (Feb–Apr 2026, via UPS) --------------------
  ('LL01-00000000202', 'P150', 'shipped', 'Kaiti Klucas',               'Hokah, MN',             'UPS', 'US shipment 2026-03-03'),
  ('LL01-00000000203', 'P150', 'shipped', 'Audrey Balanay-St John',     'Kingsland, GA',         'UPS', 'US shipment 2026-03-13'),
  ('LL01-00000000205', 'P150', 'shipped', 'Tricia Bowling',             'Mobile, AL',            'UPS', 'US shipment 2026-03-10'),
  ('LL01-00000000207', 'P150', 'shipped', 'Esmeralda Burgess',          'Edgewater, MD',         'UPS', 'US shipment 2026-03-05'),
  ('LL01-00000000210', 'P150', 'shipped', 'Fred Rice',                  'Hamburg, NY',           'UPS', 'US shipment 2026-03-12'),
  ('LL01-00000000211', 'P150', 'shipped', 'Keith Taitano',              'Waianae, HI',           'UPS', 'US shipment 2026-03-05'),
  ('LL01-00000000212', 'P150', 'shipped', 'Anthony Kurt',               'Detroit, MI',           'UPS', 'US shipment 2026-03-12'),
  ('LL01-00000000215', 'P150', 'shipped', 'Heather Hall',               'Carson City, NV',       'UPS', 'US shipment 2026-03-11'),
  ('LL01-00000000216', 'P150', 'shipped', 'Michael Romans',             'Seaside, CA',           'UPS', 'US shipment 2026-03-13'),
  ('LL01-00000000217', 'P150', 'shipped', 'Rashida Lee',                'Cypress, TX',           'UPS', 'US shipment 2026-04-01'),
  ('LL01-00000000218', 'P150', 'shipped', 'Suzan Jackovatz',            'Braselton, GA',         'UPS', 'US shipment 2026-03-13'),
  ('LL01-00000000219', 'P150', 'shipped', 'Thomi Clinton',              'Desert Hot Springs, CA','UPS', 'US shipment 2026-03-12'),
  ('LL01-00000000221', 'P150', 'shipped', 'Robert Buckley',             'Pensacola, FL',         'UPS', 'US shipment 2026-03-12'),
  ('LL01-00000000223', 'P150', 'shipped', 'Sandra Colligan',            'Southborough, MA',      'UPS', 'US shipment 2026-03-11'),
  ('LL01-00000000224', 'P150', 'shipped', 'Sandra Sweet',               'Glenview, IL',          'UPS', 'US shipment 2026-03-12'),
  ('LL01-00000000227', 'P150', 'shipped', 'Kristi Blue',                'Owensboro, KY',         'UPS', 'US shipment 2026-03-05 (in transit; RTN-0029 pending)'),
  ('LL01-00000000228', 'P150', 'shipped', 'Rodney Richards',            'Greenwood, MO',         'UPS', 'US shipment 2026-02-24'),
  ('LL01-00000000229', 'P150', 'shipped', 'Dixie Bean',                 'Moorefield, WV',        'UPS', 'US shipment 2026-03-13'),
  ('LL01-00000000230', 'P150', 'shipped', 'Peter Lupachino',            'Watertown, CT',         'UPS', 'US shipment 2026-03-11'),
  ('LL01-00000000231', 'P150', 'shipped', 'Frank Nikolaidis',           'Berlin, MD',            'UPS', 'US shipment 2026-03-11'),
  ('LL01-00000000232', 'P150', 'shipped', 'Douglas Hanson',             'Yankton, SD',           'UPS', 'US shipment 2026-03-18'),
  ('LL01-00000000233', 'P150', 'shipped', 'Jeffrey Van Dyke',           'Palm Springs, CA',      'UPS', 'US shipment 2026-02-24'),
  ('LL01-00000000234', 'P150', 'shipped', 'Frederick Whittington',      'Port Republic, MD',     'UPS', 'US shipment 2026-03-13'),
  ('LL01-00000000235', 'P150', 'shipped', 'Karon Plasha',               'Arlington, VA',         'UPS', 'US shipment 2026-03-12'),
  ('LL01-00000000236', 'P150', 'shipped', 'Amila Smith',                'Lakeland, GA',          'UPS', 'US shipment 2026-02-24'),
  ('LL01-00000000238', 'P150', 'shipped', 'Jefy Chacko',                'Wilton, CT',            'UPS', 'US shipment 2026-03-12 (RTN-0028 pending shipping damage)'),
  ('LL01-00000000243', 'P150', 'shipped', 'Justin Plumley',             'Inman, SC',             'UPS', 'US shipment 2026-03-13'),
  ('LL01-00000000244', 'P150', 'shipped', 'Teresa Just',                'Layton, UT',            'UPS', 'US shipment 2026-02-24'),
  ('LL01-00000000245', 'P150', 'shipped', 'Jean Cotis',                 'Hardwick Township, NJ', 'UPS', 'US shipment 2026-03-30'),

  -- -------------------- P50N shipments --------------------
  ('LL01-00000000201', 'P50N', 'shipped', 'Jeremiah Pauw',              'BC',  'Canpar',   'P50N stock · Canada Fulfillment · received 2026-03-10'),
  ('LL01-00000000239', 'P50N', 'shipped', 'Joan Teichroeb',             'BC',  'Canpar',   'P50N replacement · received 2026-02-27 (2nd replacement)'),

  -- -------------------- Cross-batch serial reassignments (md overrides earlier seed batch) --------------------
  ('LL01-00000000005', 'P150', 'shipped', 'Mary Oskamp',                'Trenton, ON', 'Canpar', 'Canada Fulfillment · received 2026-04-14 (replacement, P150 unit reassigned from earlier cohort)'),
  ('LL01-00000000045', 'P50N', 'shipped', 'Jason Kemp',                 'Carp, ON',    'Canpar', 'Canada Fulfillment · received 2026-02-05 (P50N stock)'),

  -- -------------------- P100 shipments (Apr 2026, Container MSDU5858060) --------------------
  ('LL01-00000000273', 'P100', 'shipped', 'Rebecca Campbell',           '', '', 'P100 shipment 2026-04-20'),
  ('LL01-00000000280', 'P100', 'shipped', 'Matthew Mossey',             '', '', 'P100 priority shipment 2026-04-20'),
  ('LL01-00000000285', 'P100', 'shipped', 'Lisa Clarke',                '', '', 'P100 shipment 2026-04-17'),
  ('LL01-00000000298', 'P100', 'shipped', 'Brent Neave',                'BC','', 'P100 shipment 2026-04-17'),
  ('LL01-00000000302', 'P100', 'shipped', 'Ron Russell',                '', '', 'P100 shipment 2026-04-17')
) as v(serial, batch, status, customer_name, location, carrier, notes)
where u.serial = v.serial;
