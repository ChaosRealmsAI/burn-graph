import { createHash } from "node:crypto";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const cli = path.resolve(import.meta.dir, "../../apps/cli/src/index.ts");

type Envelope = {
  schemaVersion: number;
  ok: boolean;
  command: string;
  data?: {
    protocol: string;
    productVersion: string;
    schemaVersion: number;
    commands: Array<{ path: string }>;
    digest: string;
  };
  error?: { code: string };
};

function invoke(...args: string[]): { status: number; envelope: Envelope } {
  const result = Bun.spawnSync(["bun", cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const raw = (result.exitCode === 0 ? result.stdout : result.stderr).toString();
  return { status: result.exitCode, envelope: JSON.parse(raw) as Envelope };
}

describe("public command contract", () => {
  test("binds schema v2 to the exact command topology", () => {
    const first = invoke("contract");
    const second = invoke("contract");
    expect(first.status).toBe(0);
    expect(first.envelope).toEqual(second.envelope);
    expect(first.envelope.schemaVersion).toBe(2);
    expect(first.envelope.command).toBe("contract");
    const data = first.envelope.data!;
    expect(data.schemaVersion).toBe(2);
    expect(data.commands.map(({ path }) => path)).toContain("inspect.overview");
    expect(data.commands.map(({ path }) => path)).not.toContain("work.current");
    const { digest, ...contract } = data;
    expect(digest).toBe(
      createHash("sha256").update(JSON.stringify(contract)).digest("hex"),
    );
  });

  test("known-bad: removed legacy topology cannot masquerade as schema v1", () => {
    const result = invoke("work", "current");
    expect(result.status).not.toBe(0);
    expect(result.envelope.schemaVersion).toBe(2);
    expect(result.envelope.error?.code).toBe("INVALID_ARGUMENTS");
  });
});
