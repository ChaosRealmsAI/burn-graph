# Lightweight installation

burn-graph ships as a Bun global package containing the bundled CLI and the
read-only Viewer. The archive has no package dependencies and does not embed a
second JavaScript runtime.

## Install a release

Prerequisite: Bun 1.2.17 or newer.

Uncached SVG or PNG rendering also needs a local Chrome-family executable.
Core graph commands, cached artifacts, and Viewer serving remain available
without it.

```bash
bun add --global ./burn-graph-0.1.0-dev.6.tgz
burn-graph --version
```

After the one-time install, `burn-graph` works from any project directory.
Uninstall it with `bun remove --global burn-graph`.

## Build and install from source

```bash
bun install --frozen-lockfile
bun run install:local
```

`install:local` builds the CLI and Viewer, creates
`dist/releases/burn-graph-0.1.0-dev.6.tgz`, and installs that exact archive.

An isolated prefix is available for clean-room checks:

```bash
bun run release:pack
bun scripts/install/local.ts --prefix /tmp/burn-graph-install
/tmp/burn-graph-install/bin/burn-graph --version
```

The isolated installer test verifies package size, zero package dependencies,
parallel Assignment scheduling, persisted state, packaged SVG rendering,
Viewer lifecycle, and read-only HTTP behavior. `--prefix` and `BUN_INSTALL`
must resolve outside the source repository because Bun 1.2.17 may otherwise
treat the source manifest as the global install target.
