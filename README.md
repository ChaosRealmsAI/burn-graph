# burn-graph

`burn-graph` is a project-local CLI for AI-owned prompt graphs. An AI creates a
graph, receives guarded prompt Assignments, performs work with its own tools,
and reports results through opaque Assignment IDs. The runtime automatically
unlocks and returns successors across parallel nodes and multiple graphs.

## Install

With Bun 1.2.17 or newer, installation is one local package command:

```bash
bun add --global ./burn-graph-1.0.0-dev.1.tgz
burn-graph --version
burn-graph --help
```

The release archive is about 1.2 MB, contains the bundled CLI and Viewer, and
declares zero package dependencies. To build and install directly from this
repository, run `bun run install:local`.

## AI loop

```bash
burn-graph init
burn-graph template list
burn-graph template show vertical-slice
burn-graph template instantiate vertical-slice --input template-input.json
# Or author directly:
burn-graph help authoring
burn-graph graph example decision
burn-graph graph schema
burn-graph graph apply --input graph.json
burn-graph run start delivery
# Execute every returned Assignment prompt, then:
burn-graph done --assignment <id> --input result.json
# Done returns the next zero or more Assignments automatically.
burn-graph current
burn-graph inspect overview
burn-graph inspect metrics
burn-graph render delivery
burn-graph viewer start delivery --port 4173 --open
```

Registered machine Checks and durable Wait Signals are System Nodes: mutating
loop commands converge them automatically, while `current`, `inspect`,
`render`, Viewer, and `doctor` stay read-only.

Graph specifications are inspectable JSON, runtime state is transactional
SQLite, and the human surface is a local read-only Mermaid viewer.
Applied definitions live in `.burn/graph/graphs/` and immutable Checks in
`.burn/graph/checks/`; both can be versioned;
ephemeral SQLite state stays ignored beneath `.burn/graph/runtime/`.

`render` returns metadata for a cached project-local SVG by default; use
`--format png` for a bounded bitmap. Cache misses use a new isolated headless
Chrome-family child and never attach to an existing profile or process. Cache
hits work without a browser.

Every bounded command, including Help, version, and errors, returns a stable
JSON envelope. Start with `burn-graph --help` or
`burn-graph help authoring`. The complete installed workflow is in
[USAGE.md](USAGE.md).

See [installation](docs/install.md), [the CLI contract](docs/cli.md), and the
[GraphSpec reference](docs/graph-spec.md). Template, priority, resource, and
portfolio behavior is documented in
[template portfolio control](docs/template-portfolio.md).

## Repository boundary

This is the independently versioned code and public-documentation repository
inside Burn Workspace V6. Formal product, BDD, architecture, milestone, and
Evidence contracts live in the sibling `../privacy` repository and are never
included in the release package.
