---
name: burn-graph
description: AI-first local prompt graph control plane with a read-only live Mermaid viewer.
---

# burn-graph

Before work, read `../../../principles.json`. Product Private truth lives in
the sibling `../privacy` repository; read its `AGENTS.md` before changing a
product contract.

## Product boundary

- burn-graph owns project-local graph definitions, graph-run state,
  Assignments, transitions, evidence references, event history, Mermaid
  projection, and the local read-only Viewer.
- burn-graph never launches a model, dispatches a subagent, executes an AI
  Task, or interprets task output. AI callers receive guarded prompt
  Assignments and report outcomes. The only process-execution boundary is an
  exact immutable Check revision referenced by a Gate; shell strings and
  arbitrary Task commands remain forbidden.
- Graph specifications are JSON. Runtime state is SQLite. The CLI is the only
  supported write surface.
- This repository owns code and public technical documentation only. Product,
  BDD, architecture, milestone, feedback, and Evidence facts belong to the
  independent sibling `../privacy` repository.
- Existing sibling projects in the V6 workspace are not dependencies. Coupling
  with `burn-cli` and `burn-subagent` is JSON CLI contracts, never code imports.
- A code change must not silently edit or commit the privacy repository, and a
  privacy change must not be staged in this repository.

## Architecture

- `packages/core` owns all graph contracts, validation, state transitions,
  SQLite persistence, assignment packets, System Node persistence, events, and
  Mermaid generation. General and System Node state machines remain separate
  modules inside this package.
- `packages/system-driver` owns the bounded mutation loop that converges
  structural nodes, Gate claims/results, Wait reconciliation, and Assignment
  scheduling.
- `packages/gate` owns exact argv execution, project-confined working
  directories, selected environment inheritance, timeout, exact-child
  termination, bounded output, and result classification.
- `packages/render` owns cache identity, browser discovery, exact isolated
  headless lifecycle, artifact validation, and SVG/PNG persistence.
- `packages/templates` owns the six immutable workflow descriptors, bounded
  input generation, and no runtime state.
- `packages/core/src/scheduler.ts` owns deterministic root rotation and
  priority aging; `template-service.ts` owns atomic template registration;
  `metrics.ts` owns private-text-free runtime derivation.
- `packages/design-system` owns visual language, tokens, React components, and
  complete graph dashboard/detail Regions plus the shared browser Mermaid
  configuration.
- `apps/cli` maps arguments and JSON stdin to core calls; it owns no graph
  policy.
- `apps/viewer` is the production read-only local web surface.
- `apps/product-preview` renders deterministic scenarios from the exact design
  system Regions.

## Commands

- Source setup: `bun install --frozen-lockfile`
- Build the lightweight release: `bun run release:pack`
- Install the local release: `bun run install:local`
- Typecheck: `bun run check`
- Unit and integration tests: `bun run test`
- Build all artifacts: `bun run build`
- Full verification: `bun run verify`
- Development CLI Help: `bun run burn-graph -- --help`
- Development AI loop: `bun run burn-graph -- next --actor <actor>`
- Register a Check: `bun run burn-graph -- check apply --input <check.json>`
- Resolve a Wait: `bun run burn-graph -- signal resolve --signal <id> --route <route> --idempotency-key <key> --input <result.json>`
- Instantiate a template: `bun run burn-graph -- template instantiate <template> --input <input.json>`
- Inspect portfolio metrics: `bun run burn-graph -- inspect metrics [run-or-graph]`
- Development artifact: `bun run burn-graph -- render <run-or-graph>`
- Product Preview: `bun run preview`
- Start named Viewer: `bun run viewer:start -- <name> <project-root> [port]`
- Viewer status: `bun run viewer:status -- <name>`
- Stop named Viewer: `bun run viewer:stop -- <name>`
- Blackbox E2E: `bun run e2e`
- UP11 from the exact archive: `bun run verify:up11-e2e`
- Prove UP11 judges a wrong product red: `bun run verify:up11-red`
- Five-sample 100-node render budget: `bun run verify:render-performance`
- 128-root portfolio budget: `bun run verify:portfolio-performance`

Viewer instances support parallel operation when they use distinct names,
project roots, and ports. Runtime scripts release only their recorded PID.

## Implementation rules

- TypeScript is strict. Shared contracts exist only in `packages/core`.
- Comments are English and explain only non-obvious invariants or safety
  boundaries.
- Runtime writes stay beneath the discovered project's `.burn-graph/runtime`.
- Rendering may stop only the exact isolated browser child it created; it must
  never attach to or terminate an existing user browser or terminal process.
- Do not embed prompts, task results, credentials, or absolute user paths in
  shareable logs or committed Evidence.
- Every state mutation is transactional and emits exactly one durable event.
- Public write commands use opaque Assignment IDs; callers never select a
  Ready node directly.
- The Viewer remains read-only; no browser request may mutate graph state.
