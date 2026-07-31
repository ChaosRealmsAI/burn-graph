import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  BurnGraphError,
  discoverProjectRoot,
  ensureProjectFile,
  initializeProject,
  publishProjectFile,
  readProjectConfig,
  writeCheckSpec,
  writeGraphSpec,
} from "@burn-graph/core";
import { BurnGraphDatabase } from "../../packages/core/src/storage.ts";
import {
  openViewerLog,
  viewerInstanceStatus,
} from "../../apps/cli/src/viewer-runtime.ts";
import { sameStateGeneration } from "../../packages/core/src/state-boundary.ts";

import { createTestDirectory, removeTestProject } from "../helpers/fixtures.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const temporaryRoots: string[] = [];
const originalHome = process.env.HOME;

// Every vector runs inside an isolated fake $HOME: the walk boundary is only
// observable when the test owns both the home directory and its parent.
function sandbox(): { readonly home: string; readonly above: string } {
  const raw = createTestDirectory();
  temporaryRoots.push(raw);
  // macOS resolves the temp root through /private; the resolver compares
  // resolved paths, so the fixture must hand it the same form.
  const above = realpathSync(raw);
  const home = path.join(above, "home");
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  return { home, above };
}

function directory(...segments: string[]): string {
  const target = path.join(...segments);
  mkdirSync(target, { recursive: true });
  return target;
}

function failure(start: string): BurnGraphError {
  try {
    discoverProjectRoot(start);
  } catch (error) {
    if (error instanceof BurnGraphError) return error;
    throw error;
  }
  throw new Error(`Expected discovery to fail from ${start}`);
}

function expectUnsafe(operation: () => unknown): BurnGraphError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(BurnGraphError);
    expect((error as BurnGraphError).code).toBe("UNSAFE_STATE_ROOT");
    return error as BurnGraphError;
  }
  throw new Error("Expected an unsafe state-root failure");
}

async function expectUnsafeAsync(
  operation: () => Promise<unknown>,
): Promise<BurnGraphError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(BurnGraphError);
    expect((error as BurnGraphError).code).toBe("UNSAFE_STATE_ROOT");
    return error as BurnGraphError;
  }
  throw new Error("Expected an unsafe state-root failure");
}

test("state generation comparison preserves large adjacent identities", () => {
  const first = {
    relative: ".burn/graph/graphs/example.json",
    kind: "file" as const,
    dev: "9007199254740992",
    ino: "9007199254740992",
  };
  const adjacent = { ...first, ino: "9007199254740993" };

  // Known-bad control: the previous Number representation collapses these two
  // adjacent identities, so this proves the lossless comparison is material.
  expect(Number(first.ino)).toBe(Number(adjacent.ino));
  expect(sameStateGeneration(first, first)).toBe(true);
  expect(sameStateGeneration(first, adjacent)).toBe(false);
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  while (temporaryRoots.length > 0) {
    removeTestProject(temporaryRoots.pop()!);
  }
});

test("V1 adopts the directory that holds .burn/graph", () => {
  const { home } = sandbox();
  const project = directory(home, "p");
  initializeProject(project, NOW);

  expect(existsSync(path.join(project, ".burn", "graph", "config.json"))).toBe(
    true,
  );
  expect(discoverProjectRoot(project)).toBe(project);
});

test("V2 walks up from a nested working directory", () => {
  const { home } = sandbox();
  const project = directory(home, "p");
  initializeProject(project, NOW);
  const nested = directory(project, "a", "b", "c");

  expect(discoverProjectRoot(nested)).toBe(project);
  expect(existsSync(path.join(project, ".burn", "graph", "config.json"))).toBe(
    true,
  );
});

test("V3 reports NOT_INITIALIZED when .burn exists without graph", () => {
  const { home } = sandbox();
  const project = directory(home, "p");
  directory(project, ".burn");
  const nested = directory(project, "a");

  const error = failure(nested);
  expect(error.code).toBe("NOT_INITIALIZED");
  expect(error.message).toContain("burn-graph init");
});

test("V4 stops at $HOME and never adopts a root above it", () => {
  const { home, above } = sandbox();
  // A project above $HOME must stay invisible: the walk boundary is the only
  // thing that keeps one user's home from being swallowed by an outer root.
  initializeProject(above, NOW);
  const start = directory(home, "work", "deep");

  const error = failure(start);
  expect(error.code).toBe("NOT_INITIALIZED");
});

test("V5 skips the product global home by identity", () => {
  const { home } = sandbox();
  const globalHome = directory(home, ".burn-graph");
  initializeProject(globalHome, NOW);
  const start = directory(globalHome, "sessions");

  const error = failure(start);
  expect(error.code).toBe("NOT_INITIALIZED");
});

test("V6 fails with a stable legacy-root error naming both paths", () => {
  const { home } = sandbox();
  const project = directory(home, "p");
  directory(project, ".burn-graph", "graphs");
  writeFileSync(
    path.join(project, ".burn-graph", "config.json"),
    `${JSON.stringify({ schemaVersion: 1 })}\n`,
  );

  const error = failure(project);
  expect(error.code).toBe("LEGACY_STATE_ROOT");
  expect(error.message).toContain(".burn-graph");
  expect(error.message).toContain(".burn/graph");
  expect(error.message).toMatch(/not .*migrat/i);
  expect(error.message).toContain("burn-graph init");
});

test("V7 lets the new root win while the legacy directory remains", () => {
  const { home } = sandbox();
  const project = directory(home, "p");
  directory(project, ".burn-graph", "graphs");
  initializeProject(project, NOW);

  expect(discoverProjectRoot(project)).toBe(project);
  expect(existsSync(path.join(project, ".burn", "graph", "config.json"))).toBe(
    true,
  );
  expect(existsSync(path.join(project, ".burn-graph"))).toBe(true);
});

test("V8 init creates .burn/graph and ignores only its runtime", () => {
  const { home } = sandbox();
  const project = directory(home, "p");

  initializeProject(project, NOW);

  for (const entry of ["config.json", "graphs", "checks", "runtime"]) {
    expect(existsSync(path.join(project, ".burn", "graph", entry))).toBe(true);
  }
  const ignore = readFileSync(path.join(project, ".gitignore"), "utf8");
  const lines = ignore.split("\n").filter((line) => line.trim().length > 0);
  expect(lines.filter((line) => line === ".burn/graph/runtime/")).toHaveLength(
    1,
  );
  // Graph and Check specifications stay versioned project facts: a blanket
  // `.burn/` line would silently remove them from every consumer's history.
  expect(ignore).not.toMatch(/^\.burn\/$/m);
});

test("V8 keeps an existing .gitignore byte-identical apart from one entry", () => {
  const { home } = sandbox();
  const project = directory(home, "p");
  const ignoreFile = path.join(project, ".gitignore");
  const existing = "node_modules/\n# trailing comment without newline";
  writeFileSync(ignoreFile, existing);

  initializeProject(project, NOW);

  const updated = readFileSync(ignoreFile, "utf8");
  expect(updated.startsWith(existing)).toBe(true);
  expect(updated.split("\n").filter((line) => line === ".burn/graph/runtime/"))
    .toHaveLength(1);
});

test("V8 does not add a second entry when the ignore line already exists", () => {
  const { home } = sandbox();
  const project = directory(home, "p");
  const ignoreFile = path.join(project, ".gitignore");
  writeFileSync(ignoreFile, "dist/\n.burn/graph/runtime/\n");

  initializeProject(project, NOW);

  const updated = readFileSync(ignoreFile, "utf8");
  expect(updated).toBe("dist/\n.burn/graph/runtime/\n");
});

test("hardlink Oracle exposes an in-place project-file rewrite", () => {
  const { home } = sandbox();
  const project = directory(home, "hardlink-known-bad");
  const outside = directory(home, "hardlink-known-bad-outside");
  const outsidePeer = path.join(outside, "peer.txt");
  const projectAlias = path.join(project, ".gitignore");
  writeFileSync(outsidePeer, "outside baseline\n");
  linkSync(outsidePeer, projectAlias);

  writeFileSync(projectAlias, "known-bad in-place rewrite\n");

  expect(readFileSync(outsidePeer, "utf8")).toBe(
    "known-bad in-place rewrite\n",
  );
});

test("init detaches an existing hardlinked .gitignore before extending it", () => {
  const { home } = sandbox();
  const project = directory(home, "hardlinked-gitignore");
  const outside = directory(home, "hardlinked-gitignore-outside");
  const ignoreFile = path.join(project, ".gitignore");
  const outsidePeer = path.join(outside, "peer.gitignore");
  const original = "node_modules/\n# outside peer";
  writeFileSync(outsidePeer, original);
  chmodSync(outsidePeer, 0o640);
  linkSync(outsidePeer, ignoreFile);
  const outsideMode = lstatSync(outsidePeer).mode & 0o777;

  initializeProject(project, NOW);

  expect(readFileSync(outsidePeer, "utf8")).toBe(original);
  expect(lstatSync(outsidePeer).mode & 0o777).toBe(outsideMode);
  expect(lstatSync(ignoreFile).ino).not.toBe(lstatSync(outsidePeer).ino);
  expect(readFileSync(ignoreFile, "utf8")).toBe(
    original + "\n.burn/graph/runtime/\n",
  );
  expect(lstatSync(ignoreFile).mode & 0o777).toBe(outsideMode);
});

test("HOME and its realpath alias are never initialized or discovered", () => {
  const { home, above } = sandbox();
  const alias = path.join(above, "home-alias");
  symlinkSync(home, alias);

  expectUnsafe(() => initializeProject(home, NOW));
  expectUnsafe(() => initializeProject(alias, NOW));
  expect(existsSync(path.join(home, ".gitignore"))).toBe(false);
  expect(existsSync(path.join(home, ".burn"))).toBe(false);

  mkdirSync(path.join(home, ".burn", "graph"), { recursive: true });
  writeFileSync(path.join(home, ".burn", "graph", "config.json"), "{}\n");
  expect(failure(home).code).toBe("NOT_INITIALIZED");
  expect(failure(alias).code).toBe("NOT_INITIALIZED");
});

test("a selected project-root symlink alias is rejected before state mutation", () => {
  const { home, above } = sandbox();
  const actual = directory(above, "real-project");
  const alias = path.join(home, "project-alias");
  symlinkSync(actual, alias);

  expectUnsafe(() => initializeProject(alias, NOW));
  expect(existsSync(path.join(actual, ".gitignore"))).toBe(false);

  initializeProject(actual, NOW);
  expect(discoverProjectRoot(actual)).toBe(actual);
  expectUnsafe(() => discoverProjectRoot(alias));
  expect(readFileSync(path.join(actual, ".burn", "graph", "config.json"), "utf8")).toContain(
    '"schemaVersion": 1',
  );
});

test("a symlinked project-root parent cannot redirect initialization", () => {
  const { home, above } = sandbox();
  const outside = directory(above, "outside-project-parent");
  const parentAlias = path.join(home, "linked-parent");
  const selected = path.join(parentAlias, "new-project");
  symlinkSync(outside, parentAlias);

  expectUnsafe(() => initializeProject(selected, NOW));
  expect(existsSync(path.join(outside, "new-project", ".gitignore"))).toBe(
    false,
  );
  expect(existsSync(path.join(outside, "new-project", ".burn"))).toBe(false);
});

test("state-root migration rejects symlinked .burn and graph before mutation", () => {
  const { home } = sandbox();
  for (const component of [".burn", path.join(".burn", "graph")]) {
    const project = directory(home, `unsafe-${component.replaceAll("/", "-")}`);
    const outside = directory(home, `${path.basename(project)}-outside`);
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "unchanged\n");
    if (component === ".burn") {
      symlinkSync(outside, path.join(project, component));
    } else {
      mkdirSync(path.join(project, ".burn"));
      symlinkSync(outside, path.join(project, component));
    }

    expectUnsafe(() => initializeProject(project, NOW));
    expect(existsSync(path.join(project, ".gitignore"))).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged\n");
    expect(existsSync(path.join(outside, "config.json"))).toBe(false);
  }
});

test("publisher rejects a concurrent creator without clobbering it", () => {
  const { home } = sandbox();
  const project = directory(home, "publisher-concurrent-creator");
  initializeProject(project, NOW);
  const target = path.join(
    project,
    ".burn",
    "graph",
    "graphs",
    "created-by-race.json",
  );

  expectUnsafe(() =>
    publishProjectFile(target, "burn-graph output\n", project, {
      beforePublish: () => writeFileSync(target, "competing output\n"),
    }),
  );
  expect(readFileSync(target, "utf8")).toBe("competing output\n");
});

test("ensure publisher observes the inode it just linked", () => {
  const { home } = sandbox();
  const project = directory(home, "ensure-publish-observation");
  initializeProject(project, NOW);
  const target = path.join(
    project,
    ".burn",
    "graph",
    "runtime",
    "ensure-observation.json",
  );
  const replacement = `${target}.replacement`;

  const error = expectUnsafe(() =>
    ensureProjectFile(target, project, {
      afterPublish: () => {
        writeFileSync(replacement, "namesake replacement\n");
        unlinkSync(target);
        renameSync(replacement, target);
      },
    }),
  );
  expect(error.message).toContain("operation stopped");
  expect(error.message).toContain("check the target before retrying");
  expect(error.message).not.toContain("nothing was replaced");
  expect(readFileSync(target, "utf8")).toBe("namesake replacement\n");
  expect(existsSync(replacement)).toBe(false);
});

test("publisher rejects a replaced generation before overwriting it", () => {
  const { home } = sandbox();
  const project = directory(home, "publisher-replaced-generation");
  initializeProject(project, NOW);
  const target = path.join(
    project,
    ".burn",
    "graph",
    "graphs",
    "replaced-generation.json",
  );
  const replacement = `${target}.replacement`;
  writeFileSync(target, "accepted generation\n");

  expectUnsafe(() =>
    publishProjectFile(target, "burn-graph output\n", project, {
      beforePublish: () => {
        writeFileSync(replacement, "competing replacement\n");
        unlinkSync(target);
        renameSync(replacement, target);
      },
    }),
  );
  expect(readFileSync(target, "utf8")).toBe("competing replacement\n");
  expect(existsSync(replacement)).toBe(false);
});

test("publisher rejects a replaced selected root before writing outside", () => {
  const { home } = sandbox();
  const project = directory(home, "publisher-root-generation");
  const replacement = directory(home, "publisher-root-generation-replacement");
  const backup = path.join(home, "publisher-root-generation-original");
  initializeProject(project, NOW);
  const target = path.join(
    project,
    ".burn",
    "graph",
    "graphs",
    "root-generation.json",
  );
  const outsideTarget = path.join(
    replacement,
    ".burn",
    "graph",
    "graphs",
    "root-generation.json",
  );

  try {
    expectUnsafe(() =>
      publishProjectFile(target, "outside write\n", project, {
        beforePublish: () => {
          renameSync(path.join(project, ".burn"), path.join(replacement, ".burn"));
          renameSync(project, backup);
          renameSync(replacement, project);
        },
      }),
    );
  } finally {
    if (existsSync(project) && !existsSync(replacement)) {
      renameSync(project, replacement);
    }
    if (existsSync(backup)) renameSync(backup, project);
  }

  expect(existsSync(outsideTarget)).toBe(false);
  expect(existsSync(target)).toBe(false);
});

test("publisher rejects a selected root replaced by a symlink", () => {
  const { home } = sandbox();
  const project = directory(home, "publisher-root-symlink");
  const outside = directory(home, "publisher-root-symlink-outside");
  const backup = path.join(home, "publisher-root-symlink-original");
  initializeProject(project, NOW);
  initializeProject(outside, NOW);
  const target = path.join(
    project,
    ".burn",
    "graph",
    "graphs",
    "root-symlink.json",
  );
  const outsideTarget = path.join(
    outside,
    ".burn",
    "graph",
    "graphs",
    "root-symlink.json",
  );

  try {
    expectUnsafe(() =>
      publishProjectFile(target, "outside write\n", project, {
        beforePublish: () => {
          renameSync(project, backup);
          symlinkSync(outside, project);
        },
      }),
    );
  } finally {
    if (existsSync(project)) unlinkSync(project);
    if (existsSync(backup)) renameSync(backup, project);
  }

  expect(existsSync(outsideTarget)).toBe(false);
  expect(existsSync(target)).toBe(false);
});

test("publisher rejects a creator in the final missing-target window", () => {
  const { home } = sandbox();
  const project = directory(home, "publisher-final-window");
  initializeProject(project, NOW);
  const target = path.join(
    project,
    ".burn",
    "graph",
    "graphs",
    "final-window.json",
  );

  expectUnsafe(() =>
    publishProjectFile(target, "burn-graph output\n", project, {
      afterGenerationCheck: () => writeFileSync(target, "final creator\n"),
    }),
  );
  expect(readFileSync(target, "utf8")).toBe("final creator\n");
});

test("publisher fails closed when cleanup parent is replaced outside", () => {
  const { home } = sandbox();
  const project = directory(home, "publisher-cleanup-boundary");
  initializeProject(project, NOW);
  const parent = path.join(project, ".burn", "graph", "graphs");
  const target = path.join(parent, "manifest.json");
  const outside = directory(home, "publisher-cleanup-boundary-outside");
  const outsideManifest = path.join(outside, "manifest.json");
  writeFileSync(outsideManifest, "outside manifest\n");
  let outsideTemporary: string | undefined;

  expectUnsafe(() =>
    publishProjectFile(target, "burn-graph output\n", project, {
      beforePublish: ({ temporary }) => {
        outsideTemporary = path.join(outside, path.basename(temporary));
        writeFileSync(outsideTemporary, "outside temporary\n");
        rmSync(parent, { recursive: true, force: true });
        symlinkSync(outside, parent);
      },
    }),
  );
  expect(outsideTemporary).toBeDefined();
  expect(existsSync(outsideTemporary!)).toBe(true);
  expect(readFileSync(outsideTemporary!, "utf8")).toBe("outside temporary\n");
  expect(readFileSync(outsideManifest, "utf8")).toBe("outside manifest\n");
});

test("graph and check writers reject symlinked owner directories", () => {
  for (const component of ["graphs", "checks"] as const) {
    const { home } = sandbox();
    const project = directory(home, `unsafe-writer-${component}`);
    initializeProject(project, NOW);
    const outside = directory(home, `unsafe-writer-${component}-outside`);
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "unchanged\n");
    const owner = path.join(project, ".burn", "graph", component);
    rmSync(owner, { recursive: true, force: true });
    symlinkSync(outside, owner);

    expectUnsafe(() => {
      if (component === "graphs") {
        writeGraphSpec(project, {
          schemaVersion: 1,
          id: "writer-boundary",
          title: "Writer boundary",
          goal: "Keep graph writes confined.",
          revision: 1,
          maxActive: 1,
          nodes: [],
        });
      } else {
        writeCheckSpec(project, {
          schemaVersion: 1,
          id: "writer-boundary",
          revision: 1,
          title: "Writer boundary",
          argv: ["bun", "--version"],
          cwd: ".",
          successExitCodes: [0],
          timeoutMs: 1000,
          maxOutputBytes: 1000,
          inheritEnv: [],
          resources: [],
        });
      }
    });
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged\n");
    expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
  }
});

test("SQLite open rejects a symlinked runtime directory before mutation", () => {
  const { home } = sandbox();
  const project = directory(home, "unsafe-storage-runtime");
  initializeProject(project, NOW);
  const outside = directory(home, "unsafe-storage-runtime-outside");
  const sentinel = path.join(outside, "sentinel.txt");
  writeFileSync(sentinel, "unchanged\n");
  const runtime = path.join(project, ".burn", "graph", "runtime");
  rmSync(runtime, { recursive: true, force: true });
  symlinkSync(outside, runtime);

  expectUnsafe(() => new BurnGraphDatabase(project));
  expect(readFileSync(sentinel, "utf8")).toBe("unchanged\n");
  expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
});

test("SQLite creates new database state with mode 0600", () => {
  const { home } = sandbox();
  const project = directory(home, "storage-created-mode");
  initializeProject(project, NOW);

  const database = new BurnGraphDatabase(project);
  try {
    const file = path.join(
      project,
      ".burn",
      "graph",
      "runtime",
      "state.sqlite",
    );
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  } finally {
    database.close();
  }
});

test("SQLite detaches an existing hardlinked database before migration", () => {
  const { home } = sandbox();
  const project = directory(home, "hardlinked-storage");
  initializeProject(project, NOW);
  const file = path.join(
    project,
    ".burn",
    "graph",
    "runtime",
    "state.sqlite",
  );
  const seed = new Database(file);
  seed.exec(
    "PRAGMA journal_mode=WAL; " +
      "PRAGMA wal_autocheckpoint=0; " +
      "CREATE TABLE hardlink_sentinel(value TEXT); " +
      "INSERT INTO hardlink_sentinel VALUES ('persisted');",
  );
  const walFile = `${file}-wal`;
  expect(existsSync(walFile)).toBe(true);
  expect(lstatSync(walFile).size).toBeGreaterThan(0);

  const outside = directory(home, "hardlinked-storage-outside");
  const outsidePeer = path.join(outside, "peer.sqlite");
  linkSync(file, outsidePeer);
  const outsideBefore = readFileSync(outsidePeer);
  chmodSync(outsidePeer, 0o640);
  const outsideMode = lstatSync(outsidePeer).mode & 0o777;

  const database = new BurnGraphDatabase(project);
  expect(database.db.query("SELECT value FROM hardlink_sentinel").get()).toEqual(
    { value: "persisted" },
  );
  database.close();
  seed.close();

  expect(Buffer.from(readFileSync(outsidePeer)).equals(outsideBefore)).toBe(true);
  expect(lstatSync(outsidePeer).mode & 0o777).toBe(outsideMode);
  expect(lstatSync(file).ino).not.toBe(lstatSync(outsidePeer).ino);
});

test("discovery does not scan unrelated large runtime content", () => {
  const { home } = sandbox();
  const project = directory(home, "bounded-discovery");
  initializeProject(project, NOW);
  const unrelated = directory(
    project,
    ".burn",
    "graph",
    "runtime",
    "unrelated-large-history",
  );
  for (let index = 0; index < 512; index += 1) {
    writeFileSync(path.join(unrelated, `history-${index}.json`), "{}\n");
  }
  const outside = directory(home, "bounded-discovery-outside");
  const sentinel = path.join(outside, "sentinel.txt");
  writeFileSync(sentinel, "unchanged\n");
  symlinkSync(outside, path.join(unrelated, "unrelated-link"));

  expect(discoverProjectRoot(project)).toBe(project);
  expect(readFileSync(sentinel, "utf8")).toBe("unchanged\n");
});

test("readProjectConfig reports missing state with a product error", () => {
  const { home } = sandbox();
  const project = directory(home, "missing-config");
  directory(project, ".burn", "graph");

  try {
    readProjectConfig(project);
  } catch (error) {
    expect(error).toBeInstanceOf(BurnGraphError);
    expect((error as BurnGraphError).code).toBe("NOT_INITIALIZED");
    expect((error as BurnGraphError).message).toContain("config.json");
    return;
  }
  throw new Error("Expected readProjectConfig to report missing state");
});

test("readProjectConfig rejects a final symlink before following its namesake", () => {
  const { home } = sandbox();
  const project = directory(home, "config-read-boundary");
  const outside = directory(home, "config-read-boundary-outside");
  initializeProject(project, NOW);
  const config = path.join(project, ".burn", "graph", "config.json");
  const outsideConfig = path.join(outside, "config.json");
  const original = readFileSync(config);
  writeFileSync(outsideConfig, original);
  unlinkSync(config);
  symlinkSync(outsideConfig, config);

  expectUnsafe(() => readProjectConfig(project));
  expect(readFileSync(outsideConfig)).toEqual(original);
});

test("discovery rejects symlinked config and mutable state directories", () => {
  const { home } = sandbox();
  const configProject = directory(home, "unsafe-config");
  const configOutside = directory(home, "unsafe-config-outside");
  mkdirSync(path.join(configProject, ".burn", "graph"), { recursive: true });
  const config = {
    schemaVersion: 1,
    projectId: "outside",
    createdAt: NOW,
    defaultLeaseSeconds: 900,
    maxAssignmentsPerActor: 8,
    maxHierarchyDepth: 8,
    maxUnfinishedDescendants: 256,
  };
  writeFileSync(path.join(configOutside, "config.json"), `${JSON.stringify(config)}\n`);
  symlinkSync(
    path.join(configOutside, "config.json"),
    path.join(configProject, ".burn", "graph", "config.json"),
  );
  expectUnsafe(() => initializeProject(configProject, NOW));
  expect(existsSync(path.join(configProject, ".gitignore"))).toBe(false);
  expectUnsafe(() => discoverProjectRoot(configProject));

  for (const component of ["runtime", "graphs", "checks"]) {
    const project = directory(home, `unsafe-${component}`);
    initializeProject(project, NOW);
    const outside = directory(home, `unsafe-${component}-outside`);
    const componentPath = path.join(project, ".burn", "graph", component);
    rmSync(componentPath, { recursive: true, force: true });
    symlinkSync(outside, componentPath);
    expectUnsafe(() => discoverProjectRoot(project));
  }
});

test("Viewer runtime symlinks fail before reading or writing outside", async () => {
  const { home } = sandbox();
  const project = directory(home, "unsafe-viewer");
  initializeProject(project, NOW);
  const outside = directory(home, "unsafe-viewer-outside");
  const sentinel = path.join(outside, "sentinel.txt");
  writeFileSync(sentinel, "unchanged\n");
  symlinkSync(
    outside,
    path.join(project, ".burn", "graph", "runtime", "viewers"),
  );

  await expectUnsafeAsync(() => viewerInstanceStatus(project, "default"));
  expect(readFileSync(sentinel, "utf8")).toBe("unchanged\n");
  expect(existsSync(path.join(outside, "default.json"))).toBe(false);
});

test("Viewer record reads preserve a hardlinked outside peer", async () => {
  const { home } = sandbox();
  const project = directory(home, "viewer-record-read");
  initializeProject(project, NOW);
  const viewers = directory(
    project,
    ".burn",
    "graph",
    "runtime",
    "viewers",
  );
  const outside = directory(home, "viewer-record-read-outside");
  const outsidePeer = path.join(outside, "peer.json");
  const recordFile = path.join(viewers, "default.json");
  const record = {
    schemaVersion: 1,
    name: "default",
    pid: 999999,
    projectRoot: project,
    port: 4173,
    url: "http://127.0.0.1:4173",
    logFile: path.join(viewers, "default.log"),
    entryFile: path.join(project, "entry.js"),
    instanceToken: "record-read-token",
    startedAt: NOW,
  };
  const bytes = `${JSON.stringify(record)}\n`;
  writeFileSync(outsidePeer, bytes);
  linkSync(outsidePeer, recordFile);

  expect((await viewerInstanceStatus(project, "default")).name).toBe("default");
  expect(readFileSync(outsidePeer, "utf8")).toBe(bytes);
});

test("Viewer log detaches an existing hardlink before handing its descriptor to the child", () => {
  const { home } = sandbox();
  const project = directory(home, "hardlinked-viewer-log");
  initializeProject(project, NOW);
  const viewers = directory(
    project,
    ".burn",
    "graph",
    "runtime",
    "viewers",
  );
  const outside = directory(home, "hardlinked-viewer-log-outside");
  const outsidePeer = path.join(outside, "peer.log");
  const logFile = path.join(viewers, "default.log");
  writeFileSync(outsidePeer, "before\n");
  chmodSync(outsidePeer, 0o640);
  linkSync(outsidePeer, logFile);
  const outsideMode = lstatSync(outsidePeer).mode & 0o777;

  const descriptor = openViewerLog(project, logFile);
  writeSync(descriptor, "child output\n");
  closeSync(descriptor);

  expect(readFileSync(outsidePeer, "utf8")).toBe("before\n");
  expect(lstatSync(outsidePeer).mode & 0o777).toBe(outsideMode);
  expect(lstatSync(logFile).ino).not.toBe(lstatSync(outsidePeer).ino);
  expect(readFileSync(logFile, "utf8")).toBe("before\nchild output\n");
  expect(lstatSync(logFile).mode & 0o777).toBe(outsideMode);
});

test("init refuses to write through a .gitignore symlink", () => {
  const { home } = sandbox();
  const project = directory(home, "p");
  const outside = path.join(home, "outside-gitignore");
  writeFileSync(outside, "user content\n");
  symlinkSync(outside, path.join(project, ".gitignore"));

  const error = (() => {
    try {
      initializeProject(project, NOW);
    } catch (thrown) {
      if (thrown instanceof BurnGraphError) return thrown;
      throw thrown;
    }
    throw new Error("Expected init to refuse the symlinked .gitignore");
  })();

  expect(error.code).toBe("UNSAFE_PROJECT_FILE");
  expect(readFileSync(outside, "utf8")).toBe("user content\n");
});
