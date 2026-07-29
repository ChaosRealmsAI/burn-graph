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

## Region ownership

- `GraphOverviewRegion`: multi-graph status, progress, and selection.
- `GraphDetailRegion`: graph header, Mermaid canvas, status legend, selected
  node contract, and event timeline.
- Product Preview and production Viewer compose these exact Regions.
