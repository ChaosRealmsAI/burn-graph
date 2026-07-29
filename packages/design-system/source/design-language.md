# burn-graph design language

## Meaning

The Viewer is an operations surface, not a decorative diagram editor. Dense
state must remain calm, scannable, and trustworthy while several graphs move.

## Testable rules

- The page uses one dark neutral canvas and one raised neutral surface family;
  arbitrary card colors are forbidden.
- Product state is never conveyed by color alone: every status has visible text
  and every Mermaid node keeps its type shape.
- Ready is blue, Running is amber, Done is green, Blocked/Failed is red, and
  Pending/Skipped is neutral throughout the product.
- The current graph title and progress are the first visual hierarchy; totals
  and timestamps remain secondary.
- Body text is at least 14px, interactive targets at least 40px, and keyboard
  focus is always visible.
- Monospace is reserved for IDs, routes, commands, and machine payloads.
- Motion is limited to state transitions and reconnect feedback; reduced-motion
  users receive no continuous animation.
- Narrow layouts become one column without hiding graph state or node detail.
- Empty, reconnecting, error, blocked, and success states explain the next
  available action.
- Prompt and result text wrap safely and never expand the diagram canvas.
- A root Run is visually distinct through depth, descendant count, and priority
  text; indentation or color alone never communicates hierarchy.
- Child Runs are folded by default. Expansion always states rendered depth,
  rendered node count, and remaining folded Runs.
- Gate and Wait use distinct node shapes and explicit labels. Machine failure,
  external waiting, and AI blocking must never share one ambiguous status.
- Metrics show only bounded evidence with units. A positive verdict never uses
  celebratory color before its declared Gates settle.
- Pausing is amber while owned work quiesces. Cancelling uses the blocked red
  family until exact Gate cleanup ends; Cancelled is terminal. None of these
  states may be collapsed into Paused or Failed while live handles remain.

## Region ownership

- `GraphOverviewRegion`: multi-graph status, progress, and selection.
- `GraphDetailRegion`: graph header, Mermaid canvas, status legend, selected
  node contract, child Runs, bounded metrics, and event timeline.
- Product Preview and production Viewer compose these exact Regions.
