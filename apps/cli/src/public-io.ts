import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import {
  BurnGraphError,
  discoverProjectRoot,
  type RuntimeChange,
} from "@burn-graph/core";

export const MAX_JSON_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_ENVELOPE_BYTES = 256 * 1024;

export interface NextAction {
  readonly id: string;
  readonly command: string;
  readonly description: string;
}

export interface Envelope {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly command: string;
  readonly data?: unknown;
  readonly changes?: readonly RuntimeChange[];
  readonly nextActions?: readonly NextAction[];
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details: Readonly<Record<string, unknown>>;
  };
  readonly recoveryActions?: readonly NextAction[];
}

function rawRootOption(): string | undefined {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--root") return args[index + 1];
    if (value.startsWith("--root=")) return value.slice("--root=".length);
  }
  return undefined;
}

function outputRootCandidates(rootInput?: string): readonly string[] {
  const candidates = new Set<string>();
  const addCandidate = (candidate: string): void => {
    const resolved = path.resolve(candidate);
    if (resolved === path.parse(resolved).root) return;
    candidates.add(resolved);
  };
  for (const input of [rootInput, rawRootOption(), process.cwd()]) {
    if (!input) continue;
    const resolved = path.resolve(input);
    addCandidate(resolved);
    try {
      addCandidate(realpathSync(resolved));
    } catch {
      // A parser or initialization error may refer to a path not created yet.
    }
    try {
      const projectRoot = discoverProjectRoot(resolved);
      addCandidate(projectRoot);
      addCandidate(realpathSync(projectRoot));
    } catch {
      // Help and version do not require an initialized project.
    }
  }
  return [...candidates].sort((left, right) => right.length - left.length);
}

function sanitizePublicString(
  input: string,
  roots: readonly string[],
): string {
  let output = input;
  for (const root of roots) {
    output = output.replaceAll(root, ".");
    const normalized = root.replaceAll("\\", "/");
    if (normalized !== root) output = output.replaceAll(normalized, ".");
  }
  output = output.replace(
    /(["'])(?:\/|[A-Za-z]:[\\/]|\\\\)[^"' \r\n]*\1/g,
    (_match, quote: string) => `${quote}<absolute-path>${quote}`,
  );
  output = output.replace(
    /(^|[\s(=])(?:\/[^ \t\r\n,;)\]}]+|[A-Za-z]:[\\/][^ \t\r\n,;)\]}]+)/g,
    (_match, prefix: string) => `${prefix}<absolute-path>`,
  );
  if (
    path.isAbsolute(output) ||
    /^[A-Za-z]:[\\/]/.test(output) ||
    output.startsWith("\\\\")
  ) {
    return "<absolute-path>";
  }
  return output;
}

function sanitizePublicValue(
  value: unknown,
  roots: readonly string[],
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") return sanitizePublicString(value, roots);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "<circular>";
  seen.add(value);
  if (Array.isArray(value)) {
    const sanitized = value.map((item) =>
      sanitizePublicValue(item, roots, seen)
    );
    seen.delete(value);
    return sanitized;
  }
  const sanitized = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sanitizePublicValue(item, roots, seen),
    ]),
  );
  seen.delete(value);
  return sanitized;
}

export function printEnvelope(
  envelope: Envelope,
  options: {
    readonly pretty: boolean;
    readonly rootInput?: string;
  },
): void {
  const roots = outputRootCandidates(options.rootInput);
  let publicEnvelope = sanitizePublicValue(envelope, roots) as Envelope;
  let output = JSON.stringify(
    publicEnvelope,
    null,
    options.pretty ? 2 : undefined,
  );
  if (
    options.pretty &&
    Buffer.byteLength(output) > MAX_ENVELOPE_BYTES
  ) {
    const compact = JSON.stringify(publicEnvelope);
    if (Buffer.byteLength(compact) <= MAX_ENVELOPE_BYTES) {
      output = compact;
    }
  }
  if (Buffer.byteLength(output) > MAX_ENVELOPE_BYTES) {
    const originalBytes = Buffer.byteLength(output);
    if (
      publicEnvelope.ok &&
      publicEnvelope.changes !== undefined &&
      publicEnvelope.changes.length > 0
    ) {
      const data =
        typeof publicEnvelope.data === "object" &&
        publicEnvelope.data !== null &&
        !Array.isArray(publicEnvelope.data)
          ? publicEnvelope.data as Readonly<Record<string, unknown>>
          : {};
      const actorId =
        typeof data["actorId"] === "string" ? data["actorId"] : null;
      const state =
        typeof data["state"] === "string" ? data["state"] : null;
      const replayed =
        typeof data["replayed"] === "boolean" ? data["replayed"] : null;
      publicEnvelope = {
        schemaVersion: 1,
        ok: true,
        command: envelope.command,
        data: {
          boundedReceipt: true,
          responseOmitted: true,
          originalBytes,
          sha256: createHash("sha256").update(output).digest("hex"),
          committedChangeCount: publicEnvelope.changes.length,
          ...(actorId === null ? {} : { actorId }),
          ...(state === null ? {} : { state }),
          ...(replayed === null ? {} : { replayed }),
        },
        nextActions: [
          ...(actorId === null
            ? []
            : [{
                id: "current",
                command: `burn-graph current --actor ${actorId}`,
                description:
                  "Read the Actor's complete bounded Assignment packets.",
              }]),
          {
            id: "overview",
            command: "burn-graph inspect overview",
            description:
              "Confirm committed state through a bounded read-only projection.",
          },
        ],
      };
    } else {
      publicEnvelope = {
        schemaVersion: 1,
        ok: false,
        command: envelope.command,
        error: {
          code: "OUTPUT_LIMIT_EXCEEDED",
          message: "Response exceeds the public JSON envelope limit",
          retryable: false,
          details: { maximumBytes: MAX_ENVELOPE_BYTES },
        },
        recoveryActions: [
          {
            id: "narrow",
            command: "burn-graph help inspect",
            description: "Use a narrower filter or lower result limit.",
          },
        ],
      };
      process.exitCode = 1;
    }
    output = JSON.stringify(
      publicEnvelope,
      null,
      options.pretty ? 2 : undefined,
    );
  }
  const stream = publicEnvelope.ok ? process.stdout : process.stderr;
  stream.write(`${output}\n`);
}

async function readBoundedStdin(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    byteCount += result.value.byteLength;
    if (byteCount > MAX_JSON_INPUT_BYTES) {
      await reader.cancel();
      throw new BurnGraphError(
        "INPUT_TOO_LARGE",
        "JSON input exceeds the 2 MiB limit",
      );
    }
    chunks.push(result.value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    byteCount,
  ).toString("utf8");
}

export async function readConfinedJsonInput(
  input: string,
  rootInput: string,
): Promise<unknown> {
  let text: string;
  if (input === "-") {
    text = await readBoundedStdin();
  } else {
    const segments = input.split(/[\\/]/);
    if (
      input.includes("\0") ||
      input.startsWith("~") ||
      path.isAbsolute(input) ||
      /^[A-Za-z]:[\\/]/.test(input) ||
      input.startsWith("\\\\") ||
      segments.includes("..")
    ) {
      throw new BurnGraphError(
        "INVALID_INPUT_PATH",
        "JSON input must use a confined project-relative file or stdin",
        false,
        { stdin: "--input -" },
      );
    }
    const projectRoot = realpathSync(discoverProjectRoot(rootInput));
    const candidate = path.resolve(projectRoot, input);
    let realCandidate: string;
    try {
      realCandidate = realpathSync(candidate);
    } catch {
      throw new BurnGraphError(
        "INPUT_NOT_FOUND",
        "The project-relative JSON input file does not exist",
        false,
        { stdin: "--input -" },
      );
    }
    const relative = path.relative(projectRoot, realCandidate);
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new BurnGraphError(
        "INVALID_INPUT_PATH",
        "JSON input resolves outside the initialized project",
        false,
        { stdin: "--input -" },
      );
    }
    let descriptor: number;
    try {
      descriptor = openSync(
        realCandidate,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch {
      throw new BurnGraphError(
        "INPUT_NOT_READABLE",
        "The project-relative JSON input file cannot be read",
        false,
        { stdin: "--input -" },
      );
    }
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile()) {
        throw new BurnGraphError(
          "INVALID_INPUT_PATH",
          "JSON input must resolve to one regular project file",
          false,
          { stdin: "--input -" },
        );
      }
      if (metadata.size > MAX_JSON_INPUT_BYTES) {
        throw new BurnGraphError(
          "INPUT_TOO_LARGE",
          "JSON input exceeds the 2 MiB limit",
        );
      }
      text = readFileSync(descriptor, "utf8");
    } finally {
      closeSync(descriptor);
    }
  }
  if (Buffer.byteLength(text) > MAX_JSON_INPUT_BYTES) {
    throw new BurnGraphError(
      "INPUT_TOO_LARGE",
      "JSON input exceeds the 2 MiB limit",
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BurnGraphError(
      "INVALID_JSON",
      error instanceof Error ? error.message : "Invalid JSON",
    );
  }
}
