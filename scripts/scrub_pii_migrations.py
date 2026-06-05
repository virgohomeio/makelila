#!/usr/bin/env python3
"""One-shot: replace real customer PII in seed migrations with synthetic placeholders.

Scope: only the seed/back-fill migrations that embed real customer data as SQL
literals. Operational fields (order refs, serials, tracking numbers, dates,
line_items, prices, statuses) are preserved so the migrations still run and the
demo keeps its shape. Geographic columns (city/state/postal) are kept; the
identifying street address_line is replaced.

Idempotent-ish: re-running after a successful scrub is a no-op (the real
literals are gone). Run from repo root.
"""
import re
import sys
import pathlib

MIG = pathlib.Path("supabase/migrations")

TARGETS = [
    "20260418023623_seed_orders.sql",
    "20260418142435_reseed_orders.sql",
    "20260418181606_reseed_six_orders.sql",
    "20260421120000_seed_ron_russell_return.sql",
    "20260421140000_ron_russell_structured.sql",
    "20260421150000_auto_refund_from_customer_return.sql",
    "20260519140000_seed_katrina_dowd_return.sql",
    "20260605080000_orders_tracking_carrier_and_replacement_import.sql",
    "20260603120100_cron_sync_hubspot_customers.sql",
]

# --- Names -----------------------------------------------------------------
# Ron & Katrina get coherent synthetic identities (referenced by first name in
# prose + joined by email across files). Everyone else gets a synthetic name
# from a deterministic pool.
EXPLICIT_NAMES = {
    "Ron Russell": "Riley Sample",
    "Katrina Dowd": "Kendra Sample",
}
OTHER_NAMES = [
    "Louis DiPalma", "Brent Neave", "Phayvanh Nanthavongdouangsy",
    "Annmarie Kennedy", "Sarah Harris", "Kristen Pimentel", "Cole Perkins",
    "Jake Wenger", "Brittany Hemenway", "Rebecca Campbell", "Gina Daniels",
    "Suzanne McRae", "Dale Bober", "Chris & Renata Grant", "Jason Amero",
    "Mark Marshall", "Brent Baker (Neave)", "Leen Schafer", "Donna Wood",
    "Tony Rinella", "Kevin Cheng", "Angeline Purcell",
    "Scott Gilbert & Karolina Chmiel", "Jeffrey Van Dyke", "Tien Tran",
    "Michael Madigan", "Tamara Martin", "Candace Chan", "Ellery Bunn",
    "Brian Fryer", "Connie Beatty", "Fred Rice", "Patrick Taylor",
    "Shearries Moseley Lafontaine", "Jeff Carnahan", "Vicki Myhre", "Judy Mahon",
    # First seed_orders.sql (20260418023623) — demo personas, scrubbed too for
    # a zero-doubt end state.
    "Keith Taitano", "Marianne Chen", "Raymond Park", "Ashley Brooks",
    "Gordon Huang", "Nora Bélanger", "Derek Sloan", "Melanie Ortiz",
]
SYN_FIRST = ["Avery", "Blake", "Casey", "Drew", "Emerson", "Finley", "Gray",
             "Harper", "Indigo", "Jordan", "Kai", "Logan", "Morgan", "Noel",
             "Oakley", "Parker", "Quinn", "Reese", "Sage", "Tatum", "Urban",
             "Vesper", "Wren", "Xen", "Yael", "Zion", "Ari", "Bell", "Cleo",
             "Dale", "Eden", "Fern", "Gale", "Hollis", "Ira", "Joss", "Lane",
             "Marlow", "Nico", "Onyx"]
SYN_LAST = ["Archer", "Brooks", "Carver", "Dunn", "Ellis", "Forrest", "Greer",
            "Hale", "Irving", "Jensen", "Keene", "Lowry", "Mercer", "Nash",
            "Oakes", "Pike", "Quill", "Rhodes", "Sterling", "Thorne", "Underhill",
            "Vance", "Whitlock", "Xander", "Yardley", "Zane", "Ames", "Birch",
            "Crane", "Doyle", "East", "Frost", "Gable", "Holt", "Ipsen", "Jove",
            "Kerr", "Lund", "Mott", "Noble"]

name_map = dict(EXPLICIT_NAMES)
for i, real in enumerate(OTHER_NAMES):
    name_map[real] = f"{SYN_FIRST[i % len(SYN_FIRST)]} {SYN_LAST[i % len(SYN_LAST)]}"

# --- Emails ----------------------------------------------------------------
EXPLICIT_EMAILS = {
    "ron@newcmi.ca": "riley.sample@example.com",
    "Katrinadowd83@gmail.com": "kendra.sample@example.com",
    "pedruma71@gmail.com": "team.member@example.com",  # staff personal email in a comment
}
OTHER_EMAILS = [
    "ljdpdm@me.com", "b.neave@shaw.ca", "phayvanh.n@gmail.com",
    "wenger.jake@gmail.com", "bnhemenway@gmail.com", "campbellra652@gmail.com",
    "anmarik@comcast.net", "gdaniels@mw.foreverlawn.com", "suemmcrae@gmail.com",
    "dalebober@gmail.com", "cb.grant@hotmail.com", "m.c.marshall@sympatico.ca",
    "brent@baker-neave.com", "leenschafer@gmail.com", "smilesarefree6@gmail.com",
    "rinellat@hotmail.com", "ziontkd.markham@gmail.com", "annpurcell123@hotmail.com",
    "jeffreyvandyke@comcast.net", "ellery.bunn@gmail.com", "ricefj50@yahoo.com",
    "shearries@gmail.com", "worldcoast@gmail.com", "svmyhre@shaw.ca",
    "judymml@sasktel.net",
    "keith.taitano@gmail.com", "marianne.chen@protonmail.com", "ray.park@hotmail.com",
    "abrooks@yahoo.com", "gordon.h@icloud.com", "nora.belanger@videotron.ca",
    "m.ortiz@outlook.com",
]
email_map = dict(EXPLICIT_EMAILS)
for i, real in enumerate(OTHER_EMAILS):
    email_map[real] = f"customer{i + 1:02d}@example.com"

# --- Phones ----------------------------------------------------------------
# Exact literal forms as they appear in the SQL (incl. the "6014-..." form typo).
REAL_PHONES = [
    "+13039199498", "+16043292421", "+16048344451", "+16199167732", "+19514470231",
    "(604) 834-4451", "604-834-4451", "6014-834-4451", "(813) 492-5113",
    "218-301-4249", "775-250-8351", "902-818-8352", "203-895-2263", "208-409-3929",
    "416-624-9647", "760-799-9286", "905-301-7988", "519-533-8989", "(604) 329-2421",
    "(949) 554-9788", "905-330-5289", "416-783-2550", "416-887-4779", "506-523-7006",
    "971-344-2438", "416-797-9143", "814-688-7182", "236-333-6787", "403-901-9472",
    "306-441-7110",
    "+15035550101", "+16042225599", "+14168904412", "+12069991112", "+14155550123",
    "+15145551234", "+19075550000", "+13055550189",
]
# Longest-first so "604-834-4451" doesn't partially clobber "6014-834-4451".
phone_map = {}
for i, real in enumerate(sorted(REAL_PHONES, key=len, reverse=True)):
    phone_map[real] = f"555-01{i:02d}-0000"

# --- Street addresses ------------------------------------------------------
REAL_ADDRESSES = [
    "1285 Pelham Rd", "214 50 Avenue SW", "3401 Market St #407",
    "20757 Atlantic Puffin Dr, Grand Rapids, MN 55744, USA",
    "14032 Crested Moss Ct, Reno, NV, 89511, USA",
    "304-716 Old Sackville Rd., Lower Sackville, NS, B4C 2K3",
    "32 Walnut St, Seymour, CT, 06483, USA",
    "3102 Tinamous Rd, Eagle Mountain, UT, 84005, USA",
    "43 Peak Point Blvd, Maple, ON, Canada",
    "4021 Palo Alto Ave, Yucca Valley, CA, 92284, USA",
    "3 Father Redmond Way, Etobicoke, ON M8W 0B4",
    "675369 16th Line Innerkip ON N0J 1M0",
    "4506 Grizzly Hill Rd., Spallumcheen, British Columbia, V4Y 0M1",
    "7367 Kamwood Street, San Diego, CA, 92126, USA",
    "6 Buchanan Cres, Thorold, ON, Canada",
    "16 Marianfeld Ave Toronto ON M6B 3W3",
    "15 Charlotte Angliss Road Markham ON L3P 7W6",
    "499 Main St, Elsipogtog First Nation, NB, E4W 2X5",
    "731 E Twin Palms Dr, Palm Springs, CA, 92264, USA",
    "182 Southcrest Dr, Seagrave, ON L0C 1G0",
    "6284 Smith Rd, Hamburg, NY, 14075, USA",
    "115 Hillview Rd, Strathmore, AB, T1P 1W2",
    "2562 Cornerstone Ct, West Kelowna, BC, V4T 2Y3",
    "2847 SW Corbett Ave", "1050 Burrard St #2201", "88 Scott St #3106",
    "415 1st Ave N", "2150 Lombard St", "1234 Rue Sherbrooke O", "Mile 63 Haul Rd",
    "845 Collins Ave",
]
addr_map = {}
for i, real in enumerate(REAL_ADDRESSES):
    addr_map[real] = f"{100 + i * 7} Example St"

# Build one ordered (search, replace) list. Apply longest search first so no
# literal is a prefix of another mid-replacement.
pairs = []
pairs += list(addr_map.items())
pairs += list(email_map.items())
pairs += list(name_map.items())
pairs += list(phone_map.items())
pairs.sort(key=lambda kv: len(kv[0]), reverse=True)

# First-name prose fixes for the two named identities (after full-name pass).
FIRSTNAME_FIXES = [
    (re.compile(r"\bRon\b"), "Riley"),
    (re.compile(r"\bKatrina\b"), "Kendra"),
]

changed = []
for fname in TARGETS:
    path = MIG / fname
    text = original = path.read_text()
    for search, repl in pairs:
        text = text.replace(search, repl)
    for rx, repl in FIRSTNAME_FIXES:
        text = rx.sub(repl, text)
    if text != original:
        path.write_text(text)
        changed.append(fname)

# --- Verify: no real PII literal survives in any target file ---------------
all_text = "\n".join((MIG / f).read_text() for f in TARGETS)
leaks = []
for lit in (list(email_map) + list(phone_map) + list(addr_map)
            + list(EXPLICIT_NAMES) + OTHER_NAMES):
    if lit in all_text:
        leaks.append(lit)
for rx in (r"\bRon\b", r"\bKatrina\b"):
    if re.search(rx, all_text):
        leaks.append(rx)

print(f"Files changed: {len(changed)}")
for f in changed:
    print(f"  - {f}")
if leaks:
    print("\nLEAKS REMAINING (real PII still present):", file=sys.stderr)
    for l in leaks:
        print(f"  ! {l}", file=sys.stderr)
    sys.exit(1)
print("\nVerified: no original PII literal remains in target migrations.")
