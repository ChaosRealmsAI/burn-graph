# burn-graph

`burn-graph` is a project-local CLI for AI-owned prompt graphs. An AI creates a
graph, claims ready nodes, reads the returned assignment packet, performs work
with its own tools, and reports results. The graph records progress and
convergence without knowing which model or execution harness did the work.

## Install

With Bun 1.2.17 or newer, installation is one local package command:

```bash
bun add --global ./burn-graph-0.1.0-dev.1.tgz
burn-graph --version
```

The release archive is about 1.1 MB, contains the bundled CLI and Viewer, and
declares zero package dependencies. To build and install directly from this
repository, run `bun run install:local`.

## AI loop

```bash
burn-graph init
burn-graph graph apply --input graph.json
burn-graph run start delivery
burn-graph work ready --all
burn-graph work claim delivery implement-core --actor main
burn-graph work complete delivery implement-core --actor main --input result.json
burn-graph serve --open
```

Graph specifications are inspectable JSON, runtime state is transactional
SQLite, and the human surface is a local read-only Mermaid viewer.
Applied definitions live in `.burn-graph/graphs/` and can be versioned;
ephemeral SQLite state stays ignored beneath `.burn-graph/runtime/`.

See [installation](docs/install.md), [the CLI contract](docs/cli.md), and the
[GraphSpec reference](docs/graph-spec.md).
