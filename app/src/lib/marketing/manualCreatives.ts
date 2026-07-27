// Operator-tracked ad creatives from the manual sale-tracker sheets
// (December Holiday 2025 → Late Spring 2026). For each buyer, the exact Meta ad
// (v13a, v22a, …) the operator triangulated by hand and wrote in the Notes.
//
// Our data can't derive which specific creative a given buyer saw (Shopify/Meta
// expose no per-person ad attribution), so this curated overlay fills it. The
// auto Journey Report shows "Saw Meta Ad <creative>" whenever a buyer matches.
// makelila is the source of truth for operator-curated data — nothing overwrites
// this; extend it as new campaigns are tracked.
//
// Key = "<name lowercased>|<MMM D, YYYY EST date>" — the same name + date string
// reportCells already computes, so a buyer lines up on name + purchase date
// (handles repeat buyers like Tracey Mosey across two campaigns).

const ENTRIES: [name: string, date: string, creative: string][] = [
  // December Holiday 2025
  ['Tamara Martin', 'Dec 12, 2025', 'v6f'],
  ['Melissa Braschuk', 'Dec 13, 2025', 'v6f'],
  ['Matthew Lypkie', 'Dec 18, 2025', 'v6b'],
  ['Ryszard Dobosz', 'Dec 24, 2025', 'Main + v11b'],
  ['Elizabeth Antony', 'Dec 25, 2025', 'v9f'],
  ['Sharai Mustatia', 'Dec 26, 2025', 'v6f'],
  ['Matthew Mossey', 'Dec 26, 2025', 'v11b'],
  ['Daniel Chevalier', 'Dec 29, 2025', 'v11b'],
  ['Karen Shorey', 'Dec 30, 2025', 'v11b'],
  ['Don Saldana', 'Dec 31, 2025', 'v11b'],
  ['Angeline Purcell', 'Dec 31, 2025', 'v11b'],
  ['Joan Teichroeb', 'Dec 31, 2025', 'v11b'],
  ['Jeff Mottle', 'Dec 31, 2025', 'v11b'],

  // Winter Sale 2026
  ['Amanda McCordic', 'Jan 16, 2026', 'v14d'],
  ['Jason Kemp', 'Jan 17, 2026', 'v13a'],
  ['Amila Smith', 'Jan 19, 2026', 'v13a'],
  ['Chezo Nojang', 'Jan 19, 2026', 'v13a'],
  ['Kristi Blue', 'Jan 21, 2026', 'v15h'],
  ['Desiree Page', 'Jan 22, 2026', 'v13a'],
  ['Keith Taitano', 'Jan 23, 2026', 'v13a'],
  ['Rodney Richards', 'Jan 25, 2026', 'v15h'],
  ['Esmeralda Burgess', 'Jan 25, 2026', 'v13a'],
  ['Frank Nikolaidis', 'Jan 26, 2026', 'v15h'],
  ['Jeffrey Van Dyke', 'Jan 28, 2026', 'v15e'],
  ['Sandra Colligan', 'Jan 31, 2026', 'v13a'],
  ['Vicki Myhre', 'Feb 1, 2026', 'v15h'],
  ['Matthew Miller', 'Feb 1, 2026', 'v16d'],
  ['Heather Hall', 'Feb 1, 2026', 'v15h'],
  ['Lisa Jervis', 'Feb 2, 2026', 'v13a'],
  ['Peter Lupachino', 'Feb 3, 2026', 'v13a'],
  ['Jeannette Sanchez', 'Feb 3, 2026', 'v13a'],
  ['Thomi Clinton', 'Feb 9, 2026', 'v13a'],
  ['Jefy Chacko', 'Feb 10, 2026', 'v13a or v15h'],
  ['Douglas Hanson', 'Feb 10, 2026', 'v13a or v15h'],
  ['Jeremiah Pauw', 'Feb 12, 2026', 'v13a'],
  ['Tricia Bowling', 'Feb 13, 2026', 'v13a'],
  ['Scott Gilbert', 'Feb 13, 2026', 'v14d'],
  ['Fred Rice', 'Feb 15, 2026', 'v15h'],
  ['Robert Buckley', 'Feb 16, 2026', 'v15h'],
  ['Ron Russell', 'Feb 18, 2026', 'v13a'],
  ['Anthony Kurt', 'Feb 18, 2026', 'v13a'],
  ['Robert Simoneau', 'Feb 19, 2026', 'v13a'],
  ['Karon Plasha', 'Feb 22, 2026', 'v13a'],
  ['Sandra Sweet', 'Feb 22, 2026', 'v13a'],
  ['Ann Prendergast', 'Feb 22, 2026', 'v13a'],
  ['Joy Seargeant', 'Feb 23, 2026', 'v13a'],
  ['Dixie Bean', 'Feb 23, 2026', 'v13a'],
  ['Suzan Jackovatz', 'Feb 24, 2026', 'v13a'],
  ['Audrey Balanay-St John', 'Feb 25, 2026', 'v13a'],
  ['Justin Plumley', 'Feb 27, 2026', 'v13a'],
  ['Frederick Whittington', 'Feb 28, 2026', 'v13a'],
  ['Jean Cotis', 'Feb 28, 2026', 'v13a'],
  ['Rashida Lee', 'Mar 6, 2026', 'v13a'],

  // March Sale 2026
  ['Antonio Cernuto', 'Mar 11, 2026', 'v17b'],
  ['Rick Stauffer', 'Mar 14, 2026', 'v18a'],
  ['Scott Lies', 'Mar 16, 2026', 'v17b'],
  ['Dale Bober', 'Mar 16, 2026', 'v17b'],
  ['Brent Neave', 'Mar 18, 2026', 'v20b'],
  ['Ashley Wright', 'Mar 19, 2026', 'v17b'],
  ['Jacob Wenger', 'Mar 21, 2026', 'v20a'],
  ['Rebecca Campbell', 'Mar 22, 2026', 'v20a'],
  ['Cole Perkins', 'Mar 22, 2026', 'v17b'],
  ['Tara Dupper', 'Mar 23, 2026', 'v17b'],
  ['Angela Findlay', 'Mar 27, 2026', 'v20a'],

  // Spring Sale 2026
  ['Phayvanh Nanthavongdouangsy', 'Apr 10, 2026', 'v20a'],
  ['Annmarie Kennedy', 'Apr 10, 2026', 'v25d'],
  ['Louise Leonard', 'Apr 10, 2026', 'v22c'],
  ['Farschad Birdjandi', 'Apr 10, 2026', 'v22a'],
  ['Hung Nguyen', 'Apr 11, 2026', 'v22a'],
  ['Brittany Hemenway', 'Apr 11, 2026', 'v23b'],
  ['Lawrence Hou', 'Apr 11, 2026', 'v22a'],
  ['Leen Schafer', 'Apr 12, 2026', 'v21a'],
  ['Paul Ethier', 'Apr 12, 2026', 'v21a'],
  ['Myles Straga', 'Apr 13, 2026', 'v22a'],
  ['Erika Turner', 'Apr 13, 2026', 'v21a'],
  ['Mauro Varela', 'Apr 13, 2026', 'v22a'],
  ['Kristen Skolney', 'Apr 15, 2026', 'v21a'],
  ['Emma Daigneault', 'Apr 17, 2026', 'v22a'],
  ['Roxana Felipe', 'Apr 17, 2026', 'v22a'],
  ['Ronald Hatch', 'Apr 18, 2026', 'v22a'],
  ['Gina Daniels', 'Apr 18, 2026', 'v20a'],
  ['Heather Palbicki', 'Apr 19, 2026', 'v22a'],
  ['Stacie Reynolds', 'Apr 21, 2026', 'v22c'],
  ['Christine Reese', 'Apr 22, 2026', 'v22a'],
  ['Tracey Mosey', 'Apr 22, 2026', 'v22a'],
  ['Daniel McCann', 'Apr 24, 2026', 'v22a'],
  ['Judy Misener', 'Apr 26, 2026', 'v22a'],
  ['Malina Doell', 'Apr 28, 2026', 'v22a'],
  ['Thilagavathi Venkatachalam', 'Apr 29, 2026', 'v25d'],
  ['Patrick Taylor', 'May 1, 2026', 'v22d'],
  ['Anne Motley', 'May 1, 2026', 'v22a'],
  ['Kerriann Fotzpatrick', 'May 1, 2026', 'v23b'],
  ['Linda Dohmeier', 'May 2, 2026', 'v22a'],

  // Late Spring Sale (v2) 2026
  ['Sherry Elkins', 'May 13, 2026', 'v21a'],
  ['Kyle Fong', 'May 16, 2026', 'v28a'],
  ['Tracey Mosey', 'May 16, 2026', 'v25d'],
  ['Cassandra Dyal', 'May 17, 2026', 'v28a'],
  ['Marybeth Ribble', 'May 22, 2026', 'v20a'],
  ['Amanda Acker', 'May 25, 2026', 'v29a'],
  ['Joseph Thavundayil', 'May 26, 2026', 'v20a'],
  ['Amy Gaw', 'Jun 1, 2026', 'v20a'],
  ['Dennis Rice', 'Jun 1, 2026', 'v21a'],
  ['Ann Nock', 'Jun 2, 2026', 'v21a'],
];

const MAP = new Map(ENTRIES.map(([name, date, creative]) => [`${name.toLowerCase()}|${date}`, creative]));

/** The hand-tracked Meta ad creative for a buyer, or null if not on a sheet.
 *  `date` must be the EST "MMM D, YYYY" string reportCells already computes. */
export function manualCreative(name: string, date: string): string | null {
  return MAP.get(`${name.trim().toLowerCase()}|${date}`) ?? null;
}
