# burn-graph installed usage

`burn-graph` is a JSON-only, project-local workflow CLI for AI callers. Every
command emits one bounded envelope. Start with:

```bash
burn-graph --help
burn-graph init
burn-graph template list
burn-graph template show vertical-slice
```

Root Help intentionally exposes only `init`, `template`, `run`, `next`,
`current`, `done`, `inspect`, and `help`. Open an advanced area only when it is
needed:

```bash
burn-graph help authoring
burn-graph help lifecycle
burn-graph help diagnosis
burn-graph help recover
```

## Author a Graph

Obtain a complete example and the complete machine-readable schema:

```bash
burn-graph graph example decision
burn-graph graph schema
```

Save only the example envelope's `data.graph` value as `graph.json`, then:

```bash
burn-graph graph validate --input graph.json
burn-graph graph apply --input graph.json
burn-graph run start example-decision
```

Structured JSON accepts either `--input <project-relative-file>` or
`--input -` for stdin. File paths must remain inside the initialized project
after realpath and symlink resolution. Absolute paths and parent traversal are
rejected. Input is limited to 2 MiB. Graph and Check validation return bounded
receipts with normalized document bytes and SHA-256 instead of echoing the
whole authored document.

## Complete Assignments

`run start`, `next`, and `done` return complete Assignment packets. Execute the
packet's prompt contract, then send only the requested result JSON:

```bash
burn-graph done --assignment <opaque-id> --input -
burn-graph next
burn-graph current
```

One normalized prompt contract is limited to 32 KiB. An Actor owns at most
128 KiB of complete Assignment packets; `assignmentOutput` reports usage and
whether scheduling stopped before another claim. Completion summary, evidence,
and route share an 8 KiB successor-context limit. Node-specific `output` is not
copied into successor context.

The project Actor defaults to `primary` for current version-1 project config.
Use `--actor <id>` only when intentionally operating another Actor. Continue
until the returned Run snapshot is terminal.

## Diagnose and recover

Use read-only inspection first:

```bash
burn-graph inspect overview
burn-graph inspect ready
burn-graph inspect run <run>
burn-graph doctor
```

Errors use stable machine codes and exact `recoveryActions`. Parser errors,
Help, version, successes, and failures share envelope schema version 1 and a
256 KiB maximum. If a committed mutation's full result would exceed that
maximum, the command still exits successfully and returns a bounded receipt
with `responseOmitted`, a SHA-256 digest, and read-only recovery commands; it
never reports the committed state change as a failure. Runtime state persists
beneath `.burn-graph/`; GraphSpecs and CheckSpecs are tracked project facts,
while SQLite and diagnostics remain ignored local runtime data.

The installed package also contains generated `help/`, `schema/`, and
`examples/` assets. They mirror the exact CLI build and are optional: the CLI
responses alone are sufficient.
