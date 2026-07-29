// Purpose: Install the packaged burn-graph CLI into Bun's global bin directory.
// Usage: bun scripts/install/local.ts [--prefix <directory>]
// Notes: --prefix isolates installation by setting BUN_INSTALL for this process.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

interface SourcePackage {
  readonly version?: unknown;
}

function fail(message: string): never {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: {
        code: "INSTALL_FAILED",
        message,
        retryable: false,
      },
    })}\n`,
  );
  process.exit(1);
}

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const sourcePackage = JSON.parse(
  readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
) as SourcePackage;
if (typeof sourcePackage.version !== "string") {
  fail("package.json must declare a string version");
}

const inputs = process.argv.slice(2);
let installPrefix: string | undefined;
for (let index = 0; index < inputs.length; index += 1) {
  const input = inputs[index];
  if (input !== "--prefix") {
    fail(`Unknown install option: ${input ?? ""}`);
  }
  const value = inputs[index + 1];
  if (!value) fail("--prefix requires a directory");
  installPrefix = path.resolve(value);
  index += 1;
}

const inheritedInstallPrefix = process.env.BUN_INSTALL
  ? path.resolve(process.env.BUN_INSTALL)
  : undefined;
const effectiveInstallPrefix = installPrefix ?? inheritedInstallPrefix;
if (
  effectiveInstallPrefix &&
  (effectiveInstallPrefix === repositoryRoot ||
    effectiveInstallPrefix.startsWith(`${repositoryRoot}${path.sep}`))
) {
  fail("BUN_INSTALL and --prefix must resolve outside the source repository");
}

const archiveFile = path.join(
  repositoryRoot,
  "dist",
  "releases",
  `burn-graph-${sourcePackage.version}.tgz`,
);
if (!existsSync(archiveFile)) {
  fail(`Missing release archive: ${archiveFile}`);
}

const installEnvironment = { ...process.env };
if (installPrefix) {
  mkdirSync(installPrefix, { recursive: true });
  installEnvironment.BUN_INSTALL = installPrefix;
}

const installWorkingDirectory = mkdtempSync(
  path.join(tmpdir(), "burn-graph-install-"),
);
try {
  installEnvironment.PWD = installWorkingDirectory;
  installEnvironment.INIT_CWD = installWorkingDirectory;
  const installed = Bun.spawnSync(
    ["bun", "add", "--global", archiveFile],
    {
      cwd: installWorkingDirectory,
      env: installEnvironment,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (installed.exitCode !== 0) {
    fail(installed.stderr.toString().trim() || "bun add --global failed");
  }

  const binResult = Bun.spawnSync(["bun", "pm", "bin", "--global"], {
    cwd: installWorkingDirectory,
    env: installEnvironment,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (binResult.exitCode !== 0) {
    fail(binResult.stderr.toString().trim() || "Cannot resolve Bun global bin");
  }
  const binDirectory = binResult.stdout.toString().trim();
  const executable = path.join(binDirectory, "burn-graph");
  if (!existsSync(executable)) {
    fail(`Installed executable is missing: ${executable}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      data: {
        version: sourcePackage.version,
        executable,
        archive: archiveFile,
        prefix: effectiveInstallPrefix ?? null,
      },
    })}\n`,
  );
} finally {
  rmSync(installWorkingDirectory, { recursive: true, force: true });
}
