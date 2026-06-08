// Replacement item-tag + stage-tag derivation (spec 2026-06-08).
//
// Maps a replacement order's line_items (structured #55 shape OR the looser
// Excel-backfill shape with free-text descriptions) onto the fixed tag
// vocabulary, and derives the operator-facing stage tag. Pure functions, no
// supabase import — unit-testable without env. `import type` keeps Order
// erased at runtime so this module stays dependency-free.
import type { Order } from './orders';

export const ITEM_TAGS = [
  'P100', 'P100X', 'P150', 'starter kit', 'manual',
  'chamber-L', 'chamber-R', 'filter', 'hopper', 'lid',
  'side latch-L', 'side latch-R',
] as const;
export type ItemTag = (typeof ITEM_TAGS)[number] | string; // string allows ambiguous fallbacks (e.g. "chamber", "side latch")

export type StageTag = 'Unit' | 'awaiting batch' | 'Parts/Consumables';

// SKU → tag for the structured part line items.
const SKU_TAG: Record<string, string> = {
  'LILA-CHAMBER-L': 'chamber-L', 'LILA-CHAMBER-R': 'chamber-R', 'LILA-CHAMBER': 'chamber',
  'LILA-LATCH-SIDE-L': 'side latch-L', 'LILA-LATCH-SIDE-R': 'side latch-R', 'LILA-LATCH-SIDE': 'side latch',
  'LILA-FILTER': 'filter', 'LILA-HOPPER': 'hopper', 'LILA-LID-V36': 'lid',
  'LILA-STARTER-KIT': 'starter kit', 'LILA-MANUAL-EN': 'manual',
};

/** A tag refers to a whole unit (vs. a part/consumable) when it's a batch code
 *  like P100 / P100X / P150. */
export function isUnitTag(tag: string): boolean {
  return /^P\d/i.test(tag);
}

/** Keyword map for the looser Excel-backfill descriptions. Side-ambiguous
 *  cases (just "side latch" / "chamber" with no left/right) fall back to the
 *  un-suffixed tag so the operator can see it needs disambiguation. */
function tagsFromText(text: string): string[] {
  const s = text.toLowerCase();
  const out: string[] = [];
  if (/p100\s*x/.test(s)) out.push('P100X');
  else if (/p150/.test(s)) out.push('P150');
  else if (/p100/.test(s)) out.push('P100');

  const both = /\bboth\b/.test(s) || (/left/.test(s) && /right/.test(s));
  if (/chamber/.test(s)) {
    if (both) out.push('chamber-L', 'chamber-R');
    else if (/right/.test(s)) out.push('chamber-R');
    else if (/left/.test(s)) out.push('chamber-L');
    else out.push('chamber');
  }
  if (/latch/.test(s)) {
    if (both) out.push('side latch-L', 'side latch-R');
    else if (/right/.test(s)) out.push('side latch-R');
    else if (/left/.test(s)) out.push('side latch-L');
    else out.push('side latch');
  }
  if (/filter/.test(s)) out.push('filter');
  if (/hopper/.test(s)) out.push('hopper');
  if (/lid/.test(s)) out.push('lid');
  if (/starter/.test(s)) out.push('starter kit');
  if (/\bmanual\b/.test(s)) out.push('manual');
  return out;
}

/** Item tags for a replacement order. Reads structured SKUs/batches first,
 *  falls back to description keywords, and folds in awaiting_batch_id when the
 *  line_items carry no unit (e.g. R-0032: empty line_items, awaiting P100X). */
export function replacementItemTags(
  o: Pick<Order, 'line_items' | 'awaiting_batch_id'>,
): string[] {
  const tags: string[] = [];
  for (const raw of (o.line_items ?? []) as Array<Record<string, unknown>>) {
    const kind = raw.kind as string | undefined;
    if (kind === 'unit' || kind === 'unit_pending') {
      if (typeof raw.batch === 'string') tags.push(raw.batch);
    } else if (kind === 'part' || kind === 'part_pending') {
      const sku = raw.sku as string | undefined;
      if (sku && SKU_TAG[sku]) tags.push(SKU_TAG[sku]);
      else {
        const text = (raw.description as string) ?? (raw.name as string) ?? '';
        if (text) tags.push(...tagsFromText(text));
      }
    }
  }
  // No unit captured but the order is batch-blocked → surface the batch.
  if (!tags.some(isUnitTag) && o.awaiting_batch_id) tags.push(o.awaiting_batch_id);
  return [...new Set(tags)];
}

/** Operator-facing stage tag (spec 2026-06-08):
 *   - any unit + awaiting (out-of-stock batch) → "awaiting batch"  (e.g. P100X)
 *   - any unit, ready                          → "Unit"            (e.g. P100, P150)
 *   - parts/consumables only                   → "Parts/Consumables" */
export function replacementStageTag(
  o: Pick<Order, 'replacement_state' | 'awaiting_batch_id'>,
  tags: string[],
): StageTag | null {
  const hasUnit = tags.some(isUnitTag);
  if (hasUnit) {
    return (o.awaiting_batch_id || o.replacement_state === 'awaiting') ? 'awaiting batch' : 'Unit';
  }
  if (tags.length > 0) return 'Parts/Consumables';
  return null;
}
