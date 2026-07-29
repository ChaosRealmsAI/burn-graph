import { describe, expect, test } from "bun:test";

import { WaitSignalRestartPoc } from "../../pocs/wait-signal/restart.ts";
import { createTestDirectory, removeTestProject } from "../helpers/fixtures.ts";

describe("durable Wait restart PoC", () => {
  test("reconstructs the same opaque Signal after every process owner closes", () => {
    const root = createTestDirectory();
    const expected = {
      signalId: "signal-poc-1",
      runId: "wait-poc-r1",
      nodeId: "approval",
      routes: ["approved", "rejected"],
      deadlineAt: "2026-01-01T00:30:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as const;
    try {
      const first = new WaitSignalRestartPoc(root);
      first.materialize(expected);
      expect(first.read(expected.signalId)).toEqual(expected);
      first.close();

      const reopened = new WaitSignalRestartPoc(root);
      expect(reopened.read(expected.signalId)).toEqual(expected);
      expect(reopened.read(expected.signalId)).toEqual(expected);
      reopened.close();
    } finally {
      removeTestProject(root);
    }
  });
});
