import { createHash } from "node:crypto";

export interface ExactProcessPocInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: Readonly<Record<string, string>>;
}

export interface ExactProcessPocResult {
  readonly classification: "success" | "non_success" | "timeout" | "output_limit";
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly byteCount: number;
  readonly digest: string;
  readonly output: Uint8Array;
}

async function consumeBounded(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  onLimit: () => void,
): Promise<{ readonly bytes: Uint8Array; readonly exceeded: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let exceeded = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      const remaining = Math.max(0, maximumBytes - retained);
      if (remaining > 0) {
        const accepted = chunk.subarray(0, remaining);
        chunks.push(accepted);
        retained += accepted.byteLength;
      }
      if (chunk.byteLength > remaining && !exceeded) {
        exceeded = true;
        onLimit();
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}

export async function runExactProcessPoc(
  input: ExactProcessPocInput,
): Promise<ExactProcessPocResult> {
  const started = performance.now();
  const child = Bun.spawn([...input.argv], {
    cwd: input.cwd,
    env: { ...input.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let outputLimited = false;
  const stopExactChild = (): void => {
    if (child.exitCode === null) child.kill();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stopExactChild();
  }, input.timeoutMs);
  const stdout = consumeBounded(
    child.stdout,
    input.maxOutputBytes,
    () => {
      outputLimited = true;
      stopExactChild();
    },
  );
  const stderr = consumeBounded(
    child.stderr,
    input.maxOutputBytes,
    () => {
      outputLimited = true;
      stopExactChild();
    },
  );
  const [exitCode, stdoutResult, stderrResult] = await Promise.all([
    child.exited,
    stdout,
    stderr,
  ]);
  clearTimeout(timer);

  const maximum = input.maxOutputBytes;
  const output = new Uint8Array(
    Math.min(
      maximum,
      stdoutResult.bytes.byteLength + stderrResult.bytes.byteLength,
    ),
  );
  const stdoutBytes = stdoutResult.bytes.subarray(0, output.byteLength);
  output.set(stdoutBytes, 0);
  const stderrCapacity = output.byteLength - stdoutBytes.byteLength;
  output.set(stderrResult.bytes.subarray(0, stderrCapacity), stdoutBytes.byteLength);
  const classification = timedOut
    ? "timeout"
    : outputLimited || stdoutResult.exceeded || stderrResult.exceeded
      ? "output_limit"
      : exitCode === 0
        ? "success"
        : "non_success";
  return {
    classification,
    exitCode,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    byteCount: output.byteLength,
    digest: createHash("sha256").update(output).digest("hex"),
    output,
  };
}
