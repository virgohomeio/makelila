// Pure string scanning for the CSS token guardrail. Deliberately free of any
// I/O so it can be unit-tested; check-css-tokens.mjs owns files and exit codes.
//
// This is a string scanner, not a CSS tokenizer, so it has no notion of
// string literals: `content: "/*"` will blank live code that follows it,
// and `content: "#fff"` will be flagged as a colour literal. Neither
// pattern exists in this codebase today; a real tokenizer was judged not
// worth the complexity for a build-time guardrail.

/**
 * Finds raw hex colour literals in CSS source, ignoring anything inside
 * block comments.
 *
 * @param {string} css
 * @returns {{ line: number, column: number, hex: string }[]} hits in document order
 */
export function findRawHex(css) {
  // Declared per call, not at module scope: matchAll never mutates lastIndex
  // so a shared regex is safe today, but a shared /g regex is a landmine for
  // whoever next reaches for .test()/.exec() here. Longest alternative
  // first reads as the obvious, unsurprising order — the trailing \b means a
  // shorter branch that swallowed part of a longer run fails anyway (both
  // sides of the cut are still "word" characters), so this is defence in
  // depth rather than a fix for an observed bug.
  const hex = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;

  // Blank comments out rather than deleting them, for two reasons: (1)
  // newlines are preserved, so reported line numbers still match the file
  // the developer will open, and (2) it prevents code that only becomes
  // contiguous once the comment is gone from being read as one token — e.g.
  // `#ab/*z*/cdef` must never be reported as the fabricated literal
  // `#abcdef`, which deleting the comment outright would produce.
  // An unterminated `/*` blanks to end of string rather than failing to
  // match at all: the CSS spec treats EOF as closing an open comment, so
  // whatever follows is already dead and must not be scanned.
  const scannable = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (block) => block.replace(/[^\n]/g, ' '));

  const hits = [];
  scannable.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(hex)) {
      hits.push({ line: index + 1, column: match.index + 1, hex: match[0] });
    }
  });
  return hits;
}
