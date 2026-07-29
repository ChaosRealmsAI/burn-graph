// Purpose: Create the dependency-free Bun package used for lightweight installs.
// Usage: bun scripts/build/package.ts
// Notes: Run the CLI and Viewer builds first; generated staging stays under .tmp.

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

interface SourcePackage {
  readonly version?: unknown;
}

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const cliFile = path.join(repositoryRoot, "dist", "burn-graph.js");
const viewerDirectory = path.join(repositoryRoot, "dist", "viewer");
const sourcePackage = JSON.parse(
  readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
) as SourcePackage;

if (typeof sourcePackage.version !== "string") {
  throw new Error("package.json must declare a string version");
}
if (!existsSync(cliFile) || !existsSync(path.join(viewerDirectory, "index.html"))) {
  throw new Error("Run the CLI and Viewer builds before packaging");
}

const temporaryRoot = path.join(repositoryRoot, ".tmp", "package");
mkdirSync(temporaryRoot, { recursive: true });
const stagingRoot = mkdtempSync(path.join(temporaryRoot, "burn-graph-"));
const releaseRoot = path.join(repositoryRoot, "dist", "releases");
const archiveName = `burn-graph-${sourcePackage.version}.tgz`;
const archiveFile = path.join(releaseRoot, archiveName);

try {
  writeFileSync(
    path.join(stagingRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "burn-graph",
        version: sourcePackage.version,
        description: "AI-first local prompt graph control plane",
        type: "module",
        bin: {
          "burn-graph": "./burn-graph.js",
        },
        engines: {
          bun: ">=1.2.17",
        },
        license: "UNLICENSED",
      },
      null,
      2,
    )}\n`,
  );
  copyFileSync(cliFile, path.join(stagingRoot, "burn-graph.js"));
  chmodSync(path.join(stagingRoot, "burn-graph.js"), 0o755);
  cpSync(viewerDirectory, path.join(stagingRoot, "viewer"), {
    recursive: true,
  });
  copyFileSync(
    path.join(repositoryRoot, "README.md"),
    path.join(stagingRoot, "README.md"),
  );
  mkdirSync(releaseRoot, { recursive: true });

  const packed = Bun.spawnSync(
    [
      "bun",
      "pm",
      "pack",
      "--destination",
      releaseRoot,
      "--ignore-scripts",
    ],
    {
      cwd: stagingRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (packed.exitCode !== 0) {
    throw new Error(
      `bun pm pack failed: ${packed.stderr.toString().trim()}`,
    );
  }
  if (!existsSync(archiveFile)) {
    throw new Error(`Package archive was not created: ${archiveFile}`);
  }

  const archive = readFileSync(archiveFile);
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(archive)
    .digest("hex");
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      data: {
        artifact: path.relative(repositoryRoot, archiveFile),
        version: sourcePackage.version,
        bytes: statSync(archiveFile).size,
        sha256,
        runtime: "bun >=1.2.17",
        dependencies: 0,
      },
    })}\n`,
  );
} finally {
  if (stagingRoot.startsWith(`${temporaryRoot}${path.sep}`)) {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}
