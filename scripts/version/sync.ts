// Purpose: Propagate the root release version to workspace manifests and bun.lock.
// Usage: bun scripts/version/sync.ts --check | --write
// Notes: package.json at the repository root is the only version input.

import {
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const workspaceManifests = [
  "apps/cli/package.json",
  "apps/product-preview/package.json",
  "apps/viewer/package.json",
  "packages/core/package.json",
  "packages/design-system/package.json",
  "packages/gate/package.json",
  "packages/render/package.json",
  "packages/system-driver/package.json",
  "packages/templates/package.json",
] as const;

const mode = process.argv[2];
if (mode !== "--check" && mode !== "--write") {
  throw new Error("Use exactly --check or --write");
}

const rootManifest = JSON.parse(
  readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
) as { readonly version?: unknown };
if (
  typeof rootManifest.version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(rootManifest.version)
) {
  throw new Error("Root package.json must own one valid SemVer version");
}
const version = rootManifest.version;
const changed: string[] = [];

for (const relativeFile of workspaceManifests) {
  const file = path.join(repositoryRoot, relativeFile);
  const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
  if (manifest.version === version) continue;
  if (mode === "--check") {
    throw new Error(`${relativeFile} does not match root version ${version}`);
  }
  manifest.version = version;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  changed.push(relativeFile);
}

const lockFile = path.join(repositoryRoot, "bun.lock");
const lock = readFileSync(lockFile, "utf8");
const workspaceStart = lock.indexOf('"workspaces": {');
const packageStart = lock.indexOf('"packages": {');
if (
  workspaceStart < 0 ||
  packageStart < 0 ||
  packageStart <= workspaceStart
) {
  throw new Error("bun.lock has no readable workspace section");
}
const prefix = lock.slice(0, workspaceStart);
const workspaceSection = lock.slice(workspaceStart, packageStart);
const suffix = lock.slice(packageStart);
let versionCount = 0;
const synchronizedSection = workspaceSection.replace(
  /("version":\s*")[^"]+(")/g,
  (_match, before: string, after: string) => {
    versionCount += 1;
    return `${before}${version}${after}`;
  },
);
if (versionCount !== workspaceManifests.length) {
  throw new Error(
    `bun.lock has ${versionCount} versioned workspaces; expected ${workspaceManifests.length}`,
  );
}
if (synchronizedSection !== workspaceSection) {
  if (mode === "--check") {
    throw new Error(`bun.lock does not match root version ${version}`);
  }
  writeFileSync(lockFile, `${prefix}${synchronizedSection}${suffix}`);
  changed.push("bun.lock");
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    data: {
      mode: mode.slice(2),
      version,
      workspaceCount: workspaceManifests.length,
      changed,
    },
  })}\n`,
);
