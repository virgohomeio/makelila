// Operator-tracked fields from the manual sale-tracker sheets (December 2025 →
// Late Spring 2026): the exact Meta ad creative + the age range + gender the
// operator triangulated by hand from Meta's daily demographics.
//
// Our data can't derive per-buyer creative at all, and age/gender only when a
// campaign-day maps to a single clean Meta segment — so these curated values
// fill the Journey Report and take priority over the best-effort auto values.
// makelila is the source of truth for operator-curated data; extend this as new
// campaigns are tracked.
//
// Each row: [name, date, creative, age, gender] — '' means that field wasn't
// tracked for that buyer. Key = "<name lowercased>|<MMM D, YYYY EST date>", the
// same name + date reportCells computes, so repeat buyers (e.g. Tracey Mosey
// across two campaigns) resolve on the purchase date.

const ENTRIES: [name: string, date: string, creative: string, age: string, gender: string][] = [
  // December Holiday 2025
  ['Tamara Martin', 'Dec 12, 2025', 'v6f', '25-34', 'Male'],
  ['Melissa Braschuk', 'Dec 13, 2025', 'v6f', '35-44', 'Female'],
  ['Matthew Lypkie', 'Dec 18, 2025', 'v6b', '35-44', 'Male'],
  ['Chunli Wu', 'Dec 18, 2025', '', '50-60', ''],
  ['Ryszard Dobosz', 'Dec 24, 2025', 'Main + v11b', '35-44', 'Male'],
  ['Elizabeth Antony', 'Dec 25, 2025', 'v9f', '55-64', 'Female'],
  ['Sharai Mustatia', 'Dec 26, 2025', 'v6f', '45-54', 'Male'],
  ['Matthew Mossey', 'Dec 26, 2025', 'v11b', '65+', 'Male'],
  ['Candace Chan', 'Dec 27, 2025', '', '65+', 'Female'],
  ['Jenifer Henry', 'Dec 28, 2025', '', '45-54', 'Female'],
  ['Daniel Chevalier', 'Dec 29, 2025', 'v11b', '35-44', 'Male'],
  ['Karen Shorey', 'Dec 30, 2025', 'v11b', '65+', 'Female'],
  ['Don Saldana', 'Dec 31, 2025', 'v11b', '35-64', 'Male'],
  ['Angeline Purcell', 'Dec 31, 2025', 'v11b', '35-64', 'Female'],
  ['Joan Teichroeb', 'Dec 31, 2025', 'v11b', '35-64', 'Female'],
  ['Jeff Mottle', 'Dec 31, 2025', 'v11b', '35-64', 'Male'],

  // Winter Sale 2026
  ['Amanda McCordic', 'Jan 16, 2026', 'v14d', '35-44', 'Female'],
  ['Jason Kemp', 'Jan 17, 2026', 'v13a', '35-44', 'Male'],
  ['Amila Smith', 'Jan 19, 2026', 'v13a', '45-54', 'Female'],
  ['Chezo Nojang', 'Jan 19, 2026', 'v13a', '65+', 'Female'],
  ['Cheryl Lemieux', 'Jan 21, 2026', '', '', 'Female'],
  ['Kristi Blue', 'Jan 21, 2026', 'v15h', '45-54', 'Female'],
  ['Desiree Page', 'Jan 22, 2026', 'v13a', '55-64', 'Female'],
  ['Keith Taitano', 'Jan 23, 2026', 'v13a', '35-44', 'Male'],
  ['Rodney Richards', 'Jan 25, 2026', 'v15h', '45-54', 'Male'],
  ['Esmeralda Burgess', 'Jan 25, 2026', 'v13a', '35-44', 'Female'],
  ['Frank Nikolaidis', 'Jan 26, 2026', 'v15h', '55-64', 'Male'],
  ['Jeffrey Van Dyke', 'Jan 28, 2026', 'v15e', '65+', 'Male'],
  ['Sandra Colligan', 'Jan 31, 2026', 'v13a', '55-64', 'Female'],
  ['Vicki Myhre', 'Feb 1, 2026', 'v15h', '65+', 'Female'],
  ['Matthew Miller', 'Feb 1, 2026', 'v16d', '55-64', 'Male'],
  ['Heather Hall', 'Feb 1, 2026', 'v15h', '45-54', 'Female'],
  ['Lisa Jervis', 'Feb 2, 2026', 'v13a', '45-54', 'Female'],
  ['Peter Lupachino', 'Feb 3, 2026', 'v13a', '45-54', 'Male'],
  ['Jeannette Sanchez', 'Feb 3, 2026', 'v13a', '65+', 'Female'],
  ['Thomi Clinton', 'Feb 9, 2026', 'v13a', '55-64', 'Female'],
  ['Jefy Chacko', 'Feb 10, 2026', 'v13a or v15h', '35-64', 'Male'],
  ['Douglas Hanson', 'Feb 10, 2026', 'v13a or v15h', '35-64', 'Male'],
  ['Jeremiah Pauw', 'Feb 12, 2026', 'v13a', '25-34', 'Female'],
  ['Tricia Bowling', 'Feb 13, 2026', 'v13a', '65+', 'Female'],
  ['Scott Gilbert', 'Feb 13, 2026', 'v14d', '45-54', 'Male'],
  ['Fred Rice', 'Feb 15, 2026', 'v15h', '65+', 'Male'],
  ['Robert Buckley', 'Feb 16, 2026', 'v15h', '65+', 'Male'],
  ['Ron Russell', 'Feb 18, 2026', 'v13a', '65+', 'Male'],
  ['Anthony Kurt', 'Feb 18, 2026', 'v13a', '45-54', 'Male'],
  ['Robert Simoneau', 'Feb 19, 2026', 'v13a', '55-64', 'Male'],
  ['Karon Plasha', 'Feb 22, 2026', 'v13a', '65+', 'Female'],
  ['Sandra Sweet', 'Feb 22, 2026', 'v13a', '65+', 'Female'],
  ['Ann Prendergast', 'Feb 22, 2026', 'v13a', '65+', 'Female'],
  ['Joy Seargeant', 'Feb 23, 2026', 'v13a', '35-65+', 'Female'],
  ['Dixie Bean', 'Feb 23, 2026', 'v13a', '35-65+', 'Female'],
  ['Suzan Jackovatz', 'Feb 24, 2026', 'v13a', '55-64', 'Female'],
  ['Audrey Balanay-St John', 'Feb 25, 2026', 'v13a', '', ''],
  ['Justin Plumley', 'Feb 27, 2026', 'v13a', '35-44', 'Male'],
  ['Frederick Whittington', 'Feb 28, 2026', 'v13a', '55-64', 'Male'],
  ['Jean Cotis', 'Feb 28, 2026', 'v13a', '55-64', 'Female'],
  ['Rashida Lee', 'Mar 6, 2026', 'v13a', '45-54', 'Female'],

  // March Sale 2026
  ['Antonio Cernuto', 'Mar 11, 2026', 'v17b', '55-64', 'Male'],
  ['Rick Stauffer', 'Mar 14, 2026', 'v18a', '65+', 'Male'],
  ['Scott Lies', 'Mar 16, 2026', 'v17b', '35-44', 'Male'],
  ['Dale Bober', 'Mar 16, 2026', 'v17b', '65+', 'Male'],
  ['Brent Neave', 'Mar 18, 2026', 'v20b', '65+', 'Male'],
  ['Ashley Wright', 'Mar 19, 2026', 'v17b', '45-54', 'Female'],
  ['Jacob Wenger', 'Mar 21, 2026', 'v20a', '45-54', 'Male'],
  ['Rebecca Campbell', 'Mar 22, 2026', 'v20a', '65+', 'Female'],
  ['Cole Perkins', 'Mar 22, 2026', 'v17b', '25-34', 'Male'],
  ['Tara Dupper', 'Mar 23, 2026', 'v17b', '45-54', 'Female'],
  ['Angela Findlay', 'Mar 27, 2026', 'v20a', '45-54', 'Female'],

  // Spring Sale 2026
  ['Phayvanh Nanthavongdouangsy', 'Apr 10, 2026', 'v20a', '65+', 'Female'],
  ['Annmarie Kennedy', 'Apr 10, 2026', 'v25d', '65+', 'Female'],
  ['Louise Leonard', 'Apr 10, 2026', 'v22c', '65+', 'Female'],
  ['Farschad Birdjandi', 'Apr 10, 2026', 'v22a', '55-64', 'Male'],
  ['Hung Nguyen', 'Apr 11, 2026', 'v22a', '35-54', 'Male'],
  ['Brittany Hemenway', 'Apr 11, 2026', 'v23b', '65+', 'Female'],
  ['Lawrence Hou', 'Apr 11, 2026', 'v22a', '35-54', 'Male'],
  ['Leen Schafer', 'Apr 12, 2026', 'v21a', '55-64', 'Female'],
  ['Paul Ethier', 'Apr 12, 2026', 'v21a', '35-44', 'Female'],
  ['Myles Straga', 'Apr 13, 2026', 'v22a', '65+', 'Male'],
  ['Erika Turner', 'Apr 13, 2026', 'v21a', '55-64', 'Female'],
  ['Mauro Varela', 'Apr 13, 2026', 'v22a', '35-44', 'Male'],
  ['Kristen Skolney', 'Apr 15, 2026', 'v21a', '35-44', 'Female'],
  ['Emma Daigneault', 'Apr 17, 2026', 'v22a', '', 'Female'],
  ['Roxana Felipe', 'Apr 17, 2026', 'v22a', '', 'Female'],
  ['Ronald Hatch', 'Apr 18, 2026', 'v22a', '65+', 'Male'],
  ['Gina Daniels', 'Apr 18, 2026', 'v20a', '45-54', 'Female'],
  ['Heather Palbicki', 'Apr 19, 2026', 'v22a', '', ''],
  ['Stacie Reynolds', 'Apr 21, 2026', 'v22c', '35-44', 'Female'],
  ['Christine Reese', 'Apr 22, 2026', 'v22a', '55-64', 'Female'],
  ['Tracey Mosey', 'Apr 22, 2026', 'v22a', '55-64', 'Female'],
  ['Daniel McCann', 'Apr 24, 2026', 'v22a', '35-44', 'Female'],
  ['Judy Misener', 'Apr 26, 2026', 'v22a', '55-64', 'Female'],
  ['Malina Doell', 'Apr 28, 2026', 'v22a', '', 'Female'],
  ['Thilagavathi Venkatachalam', 'Apr 29, 2026', 'v25d', '45-54', 'Female'],
  ['Patrick Taylor', 'May 1, 2026', 'v22d', '45-54', 'Male'],
  ['Anne Motley', 'May 1, 2026', 'v22a', '45-54', 'Female'],
  ['Kerriann Fotzpatrick', 'May 1, 2026', 'v23b', '55-64', 'Female'],
  ['Linda Dohmeier', 'May 2, 2026', 'v22a', '55-64', 'Female'],

  // Late Spring Sale (v2) 2026
  ['Sherry Elkins', 'May 13, 2026', 'v21a', '55+', 'Female'],
  ['Michelle DeAnne', 'May 13, 2026', '', '55+', 'Female'],
  ['Kyle Fong', 'May 16, 2026', 'v28a', '25-34', ''],
  ['Tracey Mosey', 'May 16, 2026', 'v25d', '55-64', 'Female'],
  ['Cassandra Dyal', 'May 17, 2026', 'v28a', '35-44', 'Female'],
  ['Marybeth Ribble', 'May 22, 2026', 'v20a', '55-64', 'Female'],
  ['Amanda Acker', 'May 25, 2026', 'v29a', '55-64', 'Male'],
  ['Joseph Thavundayil', 'May 26, 2026', 'v20a', '65+', 'Male'],
  ['Amy Gaw', 'Jun 1, 2026', 'v20a', '55-64', 'Female'],
  ['Dennis Rice', 'Jun 1, 2026', 'v21a', '65+', 'Male'],
  ['Ann Nock', 'Jun 2, 2026', 'v21a', '65+', 'Female'],
];

type Tracked = { creative?: string; age?: string; gender?: string };

const MAP = new Map<string, Tracked>();
for (const [name, date, creative, age, gender] of ENTRIES) {
  MAP.set(`${name.toLowerCase()}|${date}`, {
    creative: creative || undefined,
    age: age || undefined,
    gender: gender || undefined,
  });
}

function lookup(name: string, date: string): Tracked | undefined {
  return MAP.get(`${name.trim().toLowerCase()}|${date}`);
}

/** Hand-tracked Meta ad creative for a buyer, or null. `date` = the EST
 *  "MMM D, YYYY" string reportCells computes. */
export function manualCreative(name: string, date: string): string | null {
  return lookup(name, date)?.creative ?? null;
}

/** Hand-tracked age range for a buyer, or null. */
export function manualAge(name: string, date: string): string | null {
  return lookup(name, date)?.age ?? null;
}

/** Hand-tracked gender for a buyer, or null. */
export function manualGender(name: string, date: string): string | null {
  return lookup(name, date)?.gender ?? null;
}
