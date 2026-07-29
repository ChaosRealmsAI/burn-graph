// Purpose: Provide a deterministic known-bad fixture for the rc.1 dogfood Gate.
// Usage: bun scripts/verify/rc1-dogfood-fixture.ts <seed-bad|repair|verify>
// Notes: The artifact is local runtime state; verification emits only bounded metadata.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const artifactFile = path.resolve(
  process.cwd(),
  ".burn-graph",
  "runtime",
  "artifacts",
  "rc1-known-bad.json",
);

interface Fixture {
  readonly schemaVersion: 1;
  readonly state: "bad" | "good";
}

function writeFixture(state: Fixture["state"]): void {
  mkdirSync(path.dirname(artifactFile), { recursive: true });
  const temporaryFile = `${artifactFile}.${process.pid}.tmp`;
  writeFileSync(
    temporaryFile,
    `${JSON.stringify({ schemaVersion: 1, state } satisfies Fixture)}\n`,
    { mode: 0o600 },
  );
  renameSync(temporaryFile, artifactFile);
}

function readFixture(): Fixture | null {
  if (!existsSync(artifactFile)) return null;
  try {
    const value = JSON.parse(readFileSync(artifactFile, "utf8")) as Partial<Fixture>;
    if (
      value.schemaVersion === 1 &&
      (value.state === "bad" || value.state === "good")
    ) {
      return value as Fixture;
    }
  } catch {
    return null;
  }
  return null;
}

const command = process.argv[2];
if (command === "seed-bad" || command === "repair") {
  const state = command === "seed-bad" ? "bad" : "good";
  writeFixture(state);
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, ok: true, command, state })}\n`,
  );
} else if (command === "verify") {
  const fixture = readFixture();
  const ok = fixture?.state === "good";
  const result = {
    schemaVersion: 1,
    ok,
    command,
    classification: ok ? "accepted" : "known_bad",
    state: fixture?.state ?? "missing",
  };
  (ok ? process.stdout : process.stderr).write(`${JSON.stringify(result)}\n`);
  if (!ok) process.exitCode = 9;
} else {
  process.stderr.write(
    `${JSON.stringify({
      schemaVersion: 1,
      ok: false,
      error: "Expected seed-bad, repair, or verify.",
    })}\n`,
  );
  process.exitCode = 2;
}
