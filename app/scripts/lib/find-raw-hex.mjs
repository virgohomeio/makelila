// Pure string scanning for the CSS token guardrail. Deliberately free of any
// I/O so it can be unit-tested; check-css-tokens.mjs owns files and exit codes.

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

/**
 * Finds raw hex colour literals in CSS source, ignoring anything inside
 * block comments.
 *
 * @param {string} css
 * @returns {{ line: number, hex: string }[]} hits in document order
 */
export function findRawHex(css) {
  // Blank comments out rather than deleting them: newlines are preserved, so
  // reported line numbers still match the file the developer will open.
  const scannable = css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));

  const hits = [];
  scannable.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(HEX)) {
      hits.push({ line: index + 1, hex: match[0] });
    }
  });
  return hits;
}
