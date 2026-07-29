import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { CheckSpec, GateExecutionResult } from "@burn-graph/core";

const FORCE_KILL_AFTER_MS = 250;

interface CaptureState {
  retained: number;
  limited: boolean;
  readonly stdout: Uint8Array[];
  readonly stderr: Uint8Array[];
}

export interface GateRunnerOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

function emptyResult(
  started: number,
  message: string,
): GateExecutionResult {
  const stderr = Buffer.from(message).subarray(0, 1_048_576).toString();
  return {
    classification: "spawn_error",
    exitCode: null,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    byteCount: Buffer.byteLength(stderr),
    digest: createHash("sha256").update(stderr).digest("hex"),
    stdout: "",
    stderr,
  };
}

function confinedWorkingDirectory(projectRoot: string, relative: string): string {
  const root = realpathSync(projectRoot);
  const candidate = realpathSync(path.resolve(root, relative));
  const relativeToRoot = path.relative(root, candidate);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error("Check cwd escapes the project root");
  }
  if (!statSync(candidate).isDirectory()) {
    throw new Error("Check cwd is not a directory");
  }
  return candidate;
}

function selectedEnvironment(
  check: CheckSpec,
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const name of check.inheritEnv) {
    const value = source[name];
    if (value !== undefined) selected[name] = value;
  }
  return selected;
}

async function consume(
  stream: ReadableStream<Uint8Array>,
  target: Uint8Array[],
  state: CaptureState,
  maximum: number,
  stop: () => void,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      const remaining = Math.max(0, maximum - state.retained);
      if (remaining > 0) {
        const accepted = next.value.subarray(0, remaining);
        target.push(accepted.slice());
        state.retained += accepted.byteLength;
      }
      if (next.value.byteLength > remaining && !state.limited) {
        state.limited = true;
        stop();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function runGateCheck(
  projectRoot: string,
  check: CheckSpec,
  options: GateRunnerOptions = {},
): Promise<GateExecutionResult> {
  const started = performance.now();
  let cwd: string;
  try {
    cwd = confinedWorkingDirectory(projectRoot, check.cwd);
  } catch (error) {
    return emptyResult(
      started,
      error instanceof Error ? error.message : "Invalid Check cwd",
    );
  }

  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([...check.argv], {
      cwd,
      env: selectedEnvironment(
        check,
        options.environment ?? process.env,
      ),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return emptyResult(
      started,
      error instanceof Error ? error.message : "Unable to start Check",
    );
  }

  let timedOut = false;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;
  const stopExactChild = (): void => {
    if (child.exitCode !== null) return;
    child.kill();
    forceTimer ??= setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, FORCE_KILL_AFTER_MS);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    stopExactChild();
  }, check.timeoutMs);
  const capture: CaptureState = {
    retained: 0,
    limited: false,
    stdout: [],
    stderr: [],
  };

  try {
    const [exitCode] = await Promise.all([
      child.exited,
      consume(
        child.stdout,
        capture.stdout,
        capture,
        check.maxOutputBytes,
        stopExactChild,
      ),
      consume(
        child.stderr,
        capture.stderr,
        capture,
        check.maxOutputBytes,
        stopExactChild,
      ),
    ]);
    const stdoutBytes = join(capture.stdout);
    const stderrBytes = join(capture.stderr);
    const digest = createHash("sha256")
      .update(stdoutBytes)
      .update(stderrBytes)
      .digest("hex");
    const decoder = new TextDecoder();
    return {
      classification: timedOut
        ? "timeout"
        : capture.limited
          ? "output_limit"
          : check.successExitCodes.includes(exitCode)
            ? "success"
            : "non_success",
      exitCode,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      byteCount: stdoutBytes.byteLength + stderrBytes.byteLength,
      digest,
      stdout: decoder.decode(stdoutBytes),
      stderr: decoder.decode(stderrBytes),
    };
  } catch (error) {
    stopExactChild();
    await child.exited.catch(() => undefined);
    return emptyResult(
      started,
      error instanceof Error ? error.message : "Check process failed",
    );
  } finally {
    clearTimeout(timeout);
    if (forceTimer !== null) clearTimeout(forceTimer);
  }
}
