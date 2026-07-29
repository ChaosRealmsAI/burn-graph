import {
  BurnGraphError,
  CheckSpecSchema,
  GateExecutionResultSchema,
  type CheckSpec,
  type GateExecutionResult,
} from "./contracts.ts";

export function validateCheckSpec(input: unknown): CheckSpec {
  const parsed = CheckSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new BurnGraphError(
      "INVALID_CHECK",
      "CheckSpec validation failed",
      false,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

export function validateGateExecutionResult(
  input: unknown,
  check: CheckSpec,
): GateExecutionResult {
  const parsed = GateExecutionResultSchema.safeParse(input);
  if (!parsed.success) {
    throw new BurnGraphError(
      "INVALID_CHECK_RESULT",
      "Gate execution result validation failed",
      false,
      { issues: parsed.error.issues },
    );
  }
  if (
    parsed.data.byteCount > check.maxOutputBytes ||
    Buffer.byteLength(parsed.data.stdout) +
      Buffer.byteLength(parsed.data.stderr) >
      check.maxOutputBytes
  ) {
    throw new BurnGraphError(
      "INVALID_CHECK_RESULT",
      "Gate execution output exceeds its pinned Check limit",
      false,
      { maximumBytes: check.maxOutputBytes },
    );
  }
  if (
    (parsed.data.classification === "success" &&
      (parsed.data.exitCode === null ||
        !check.successExitCodes.includes(parsed.data.exitCode))) ||
    (parsed.data.classification === "non_success" &&
      (parsed.data.exitCode === null ||
        check.successExitCodes.includes(parsed.data.exitCode))) ||
    (parsed.data.classification === "spawn_error" &&
      parsed.data.exitCode !== null)
  ) {
    throw new BurnGraphError(
      "INVALID_CHECK_RESULT",
      "Gate result classification does not match its pinned Check exit contract",
    );
  }
  return parsed.data;
}

export function gateRoute(
  result: GateExecutionResult,
): "pass" | "fail" | null {
  if (result.classification === "spawn_error") return null;
  return result.classification === "success" ? "pass" : "fail";
}

export function gateResources(
  nodeResources: readonly string[],
  checkResources: readonly string[],
): readonly string[] {
  return [...new Set([...nodeResources, ...checkResources])].sort();
}
