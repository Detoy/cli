import type { GraphEdge } from '../schema.js';

/**
 * Call-site lines on `call` edges.
 *
 * An edge records *that* a caller reaches a callee; a review diagram also needs
 * *where*, so a call-stack frame can pin its call site. Each resolver rung
 * records the 1-based line of every call it resolves, in the caller's file.
 *
 * The set is kept sorted, de-duplicated and capped at the smallest
 * {@link MAX_EDGE_SITES} lines, so the stored value depends only on which
 * lines exist, never on the order the resolver visited them.
 */
export const MAX_EDGE_SITES = 8;

export function addEdgeSite(edge: GraphEdge, line: number): void {
  if (edge.kind !== 'call' || !Number.isInteger(line) || line < 1) return;
  const sites = edge.sites ?? [];
  if (sites.includes(line)) return;
  if (sites.length >= MAX_EDGE_SITES && line > sites[sites.length - 1]) return;
  sites.push(line);
  sites.sort((a, b) => a - b);
  if (sites.length > MAX_EDGE_SITES) sites.length = MAX_EDGE_SITES;
  edge.sites = sites;
}
