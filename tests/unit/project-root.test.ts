import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { BurnGraphError, initializeProject, discoverProjectRoot } from "@burn-graph/core";

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
