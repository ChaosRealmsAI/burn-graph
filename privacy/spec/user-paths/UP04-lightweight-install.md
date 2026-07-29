# UP04 User installs burn-graph without a container

## User and starting point

A user has Bun 1.2.17 or newer and a burn-graph release archive, but no
burn-graph source checkout, package dependencies, or container runtime.

## Path

The user runs one Bun global package command against the archive. The
`burn-graph` executable becomes available on Bun's global bin path. From an
unrelated empty project, the user checks the version, initializes state,
applies a GraphSpec, starts it, and claims parallel nodes from separate CLI
processes. The installed command serves the Viewer using assets carried inside
the same package.

## Variants and recovery

Installing the same version again replaces the package through Bun's normal
global package behavior. An isolated `BUN_INSTALL` prefix supports clean
verification without changing the normal global installation. Removing the
package leaves every project's `.burn-graph` data untouched.

## End-to-end oracle

The archive is below 2 MB, declares zero package dependencies, the installed
content is below 5 MB, source manifests remain byte-identical, `--version`
exits zero, parallel CLI state converges, Viewer health returns 200, and Viewer
mutation returns 405.
