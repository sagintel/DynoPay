import type { Design } from '../../services/settings.js';
import type { Block, LeafBlock, UISpec } from './schema.js';

/**
 * Deterministic application of the user's structured design preferences to any spec
 * (defaults, saved layouts, AI output, cache replays, detail dialogs). The free-text brief
 * is handled by the agent; these always hold, with no tokens spent.
 */
const TIME_KINDS = new Set(['bar', 'line', 'area', 'sparkline', 'heatmap']);
const CATEGORY_KINDS = new Set(['bar', 'hbar', 'donut', 'pie', 'progress']);
const SALES_KINDS = new Set(['bar', 'line', 'area', 'sparkline', 'heatmap']);

/** The preferred style only replaces a chart whose data it can actually show. */
function preferredChart(kind: string, groupBy: string | undefined, direction: string | undefined, style: Design['chartStyle']) {
  if (style === 'auto' || kind === 'gauge' || direction === 'both') return kind;
  const isTime = groupBy === 'day' || groupBy === 'week' || groupBy === 'month';
  if (style === 'heatmap' && groupBy !== 'day') return kind;
  return (isTime ? TIME_KINDS : CATEGORY_KINDS).has(style) ? style : kind;
}

function applyLeaf(b: LeafBlock, d: Design): LeafBlock {
  switch (b.type) {
    case 'balance':
      // Only the default arc is swapped: an explicit compact/minimal choice by the agent stays.
      return b.variant === 'arc' && d.balanceStyle !== 'arc' ? { ...b, variant: d.balanceStyle } : b;
    case 'chart':
      return { ...b, kind: preferredChart(b.kind, b.query.groupBy ?? 'category', b.query.direction, d.chartStyle) as typeof b.kind };
    case 'merchant_sales':
      return d.chartStyle !== 'auto' && SALES_KINDS.has(d.chartStyle) ? { ...b, kind: d.chartStyle as typeof b.kind } : b;
    case 'transactions':
      return d.density === 'compact' && b.variant === 'list' ? { ...b, variant: 'compact' } : b;
    default:
      return b;
  }
}

export function applyDesign(spec: UISpec, d: Design): UISpec {
  const blocks = spec.blocks.map((b): Block =>
    b.type === 'section' || b.type === 'row' ? { ...b, children: b.children.map((c) => applyLeaf(c, d)) } : applyLeaf(b, d),
  );
  return { ...spec, blocks };
}
