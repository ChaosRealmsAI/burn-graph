// Purpose: Replay UP11 through an isolated installation of one exact archive.
// Usage: bun tests/e2e/user-paths/UP11-cli-author-run.e2e.ts [--archive <tgz>] [--output <directory>]
//        bun tests/e2e/user-paths/UP11-cli-author-run.e2e.ts --fault <kind>
//
// P011: a Gate that only ever meets a correct product proves nothing. `--fault`
// installs the same archive and then routes every public command through a
// wrapper that corrupts one semantic answer while keeping the envelope shape,
// exit status and byte budget intact. In that mode this script inverts its
// verdict — it exits 0 only when the User Path judged the wrong product red, at
// the step that owns the corrupted claim — and writes no Evidence, because a Gate
// self-test is not a User Path record.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type RunStatus = "passed" | "failed" | "blocked";
type JsonObject = Record<string, unknown>;

interface CommandObservation {
  readonly envelope: JsonObject;
  readonly milliseconds: number;
  readonly bytes: number;
}

interface StepEvidence {
  readonly id: string;
  readonly pathStep: string;
  readonly action: string;
  readonly expected: string;
  readonly observed: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: RunStatus;
}

interface StepResult<T> {
  readonly value: T;
  readonly observed: string;
}

interface FailureEvidence {
  readonly stepId: string;
  readonly summary: string;
  readonly recovery: string;
}

class UserPathFailure extends Error {
  constructor(
    readonly stepId: string,
    message: string,
  ) {
    super(message);
  }
}

const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const packageVersion = object(
  JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")),
  "package.json",
)["version"];
assertString(packageVersion, "package.json version");

function option(name: string, fallback: string): string {
  const inputs = Bun.argv.slice(2);
  const index = inputs.indexOf(name);
  if (index === -1) return path.resolve(fallback);
  const value = inputs[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return path.resolve(value);
}

const archiveFile = option(
  "--archive",
  path.join(
    repositoryRoot,
    "dist",
    "releases",
    `burn-graph-${packageVersion}.tgz`,
  ),
);
const outputDirectory = option(
  "--output",
  path.join(
    repositoryRoot,
    ".tmp",
    "e2e",
    "user-paths",
    "UP11-cli-author-run",
  ),
);
const evidenceGenerator = path.join(
  repositoryRoot,
  "scripts",
  "verify",
  "e2e-evidence.ts",
);

// Each fault is one semantically wrong answer plus the step that must catch it.
// Naming the step is what makes the self-test a Gate rather than a smoke test:
// failing anywhere else means the harness stopped for the wrong reason.
const FAULTS: Readonly<Record<string, { readonly step: string }>> = {
  "help-surface": { step: "01" },
  "completion-state": { step: "05" },
  "packaged-help-drift": { step: "07" },
};

function faultKind(): string | null {
  const inputs = Bun.argv.slice(2);
  const index = inputs.indexOf("--fault");
  if (index === -1) return null;
  const value = inputs[index + 1];
  if (value === undefined || !(value in FAULTS)) {
    throw new Error(
      `--fault requires one of ${Object.keys(FAULTS).join(", ")}`,
    );
  }
  return value;
}

const fault = faultKind();

// The wrapper is a real executable in front of the real installed command, so the
// harness exercises the same process boundary, JSON framing and byte budget it
// exercises against the product. Only one field of one response differs.
function installFaultWrapper(directory: string, real: string, kind: string): string {
  const script = path.join(directory, "burn-graph-fault.ts");
  writeFileSync(
    script,
    `#!/usr/bin/env bun
const real = ${JSON.stringify(real)};
const kind = ${JSON.stringify(kind)};
const args = Bun.argv.slice(2);
const result = Bun.spawnSync([real, ...args], {
  stdin: "inherit",
  stdout: "pipe",
  stderr: "pipe",
});
let stdout = result.stdout.toString();
function corrupt(envelope) {
  // Root Help publishes one command too many: the six-entry product loop is the
  // claim step 01 owns.
  if (kind === "help-surface" && args.includes("--help")) {
    envelope.data.commands = [
      ...envelope.data.commands,
      { name: "run", summary: "leaked compatibility area", help: "burn-graph run --help" },
    ];
    return true;
  }
  // The Run is completed but reported as still assigned: step 05 owns agreement
  // between the mutation receipt and the read-only snapshot.
  if (kind === "completion-state" && args.includes("done")) {
    envelope.data.state = "assigned";
    return true;
  }
  // Root Help drifts from the asset shipped inside the archive without changing
  // the six-command surface, so only step 07 can catch it.
  if (kind === "packaged-help-drift" && args.includes("--help")) {
    envelope.data.summary = "drifted summary the packaged asset does not carry";
    return true;
  }
  return false;
}
if (result.exitCode === 0 && stdout.trim().split("\\n").length === 1) {
  try {
    const envelope = JSON.parse(stdout.trim());
    if (corrupt(envelope)) stdout = JSON.stringify(envelope) + "\\n";
  } catch {
    // A non-JSON response is not a response this fault targets.
  }
}
process.stdout.write(stdout);
process.stderr.write(result.stderr.toString());
process.exit(result.exitCode);
`,
    { mode: 0o755 },
  );
  return script;
}

function assert(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertString(
  value: unknown,
  label: string,
): asserts value is string {
  assert(typeof value === "string" && value.length > 0, `${label} is missing`);
}

function object(value: unknown, label: string): JsonObject {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label} must be an array`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  return array(value, label).map((entry, index) => {
    assertString(entry, `${label}[${index}]`);
    return entry;
  });
}

function jsonEqual(left: unknown, right: unknown, label: string): void {
  assert(
    JSON.stringify(left) === JSON.stringify(right),
    `${label} must be semantically equal`,
  );
}

function publicMessage(error: unknown, roots: readonly string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const root of roots) {
    message = message.replaceAll(root, "<isolated-path>");
  }
  return message
    .replaceAll(/\/Users\/[^\s"]+/gu, "<isolated-path>")
    .replaceAll(/\/home\/[^\s"]+/gu, "<isolated-path>")
    .replaceAll(/\/var\/folders\/[^\s"]+/gu, "<isolated-path>");
}

function now(): string {
  return new Date().toISOString();
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function spawn(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly stdin?: string;
  },
): {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly milliseconds: number;
} {
  const started = performance.now();
  const result = Bun.spawnSync([executable, ...args], {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    ...(options.stdin === undefined
      ? {}
      : { stdin: Buffer.from(options.stdin) }),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    milliseconds: performance.now() - started,
  };
}

const testRoot = mkdtempSync(path.join(tmpdir(), "burn-graph-up11-"));
const installPrefix = path.join(testRoot, "bun-prefix");
const projectRoot = path.join(testRoot, "project");
mkdirSync(projectRoot, { recursive: true });

const privateRoots = [repositoryRoot, testRoot];
const steps: StepEvidence[] = [];
const commandDurations: number[] = [];
let maximumOutputBytes = 0;
let installedPackage = "";
let executable = "";
let installedVersion = "unknown";
let installMilliseconds = 0;
let failure: FailureEvidence | null = null;
const runStartedAt = now();

async function step<T>(
  definition: {
    readonly id: string;
    readonly pathStep: string;
    readonly action: string;
    readonly expected: string;
  },
  operation: () => Promise<StepResult<T>> | StepResult<T>,
): Promise<T> {
  const startedAt = now();
  try {
    const result = await operation();
    steps.push({
      ...definition,
      observed: result.observed,
      startedAt,
      finishedAt: now(),
      status: "passed",
    });
    return result.value;
  } catch (error) {
    const summary = publicMessage(error, privateRoots);
    steps.push({
      ...definition,
      observed: `失败：${summary}`,
      startedAt,
      finishedAt: now(),
      status: "failed",
    });
    throw new UserPathFailure(definition.id, summary);
  }
}

function invoke(
  args: readonly string[],
  options: {
    readonly stdin?: string;
    readonly expectOk?: boolean;
  } = {},
): CommandObservation {
  assert(executable.length > 0, "installed executable is unavailable");
  const result = spawn(
    executable,
    ["--root", ".", ...args],
    {
      cwd: projectRoot,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    },
  );
  const expectOk = options.expectOk ?? true;
  const serialized = (expectOk ? result.stdout : result.stderr).trim();
  assert(
    result.exitCode === (expectOk ? 0 : 1),
    `burn-graph ${args.join(" ")} exited ${result.exitCode}: ${
      (result.stderr || result.stdout).trim()
    }`,
  );
  assert(serialized.length > 0, "CLI returned no JSON envelope");
  assert(
    serialized.split("\n").length === 1,
    "CLI returned more than one JSON envelope",
  );
  const bytes = Buffer.byteLength(serialized);
  assert(bytes <= 256 * 1024, "CLI output exceeded 256 KiB");
  for (const root of privateRoots) {
    assert(!serialized.includes(root), "CLI output exposed an absolute path");
  }
  assert(
    !/\/(?:Users|home|var\/folders)\//u.test(serialized),
    "CLI output exposed a private absolute path",
  );
  const envelope = object(JSON.parse(serialized), "CLI envelope");
  assert(envelope["schemaVersion"] === 1, "CLI schemaVersion must be 1");
  assert(envelope["ok"] === expectOk, "CLI ok field disagrees with exit status");
  commandDurations.push(result.milliseconds);
  maximumOutputBytes = Math.max(maximumOutputBytes, bytes);
  return {
    envelope,
    milliseconds: result.milliseconds,
    bytes,
  };
}

function data(observation: CommandObservation, label: string): JsonObject {
  return object(observation.envelope["data"], `${label}.data`);
}

function errorCode(observation: CommandObservation): string {
  const error = object(observation.envelope["error"], "error");
  const code = error["code"];
  assertString(code, "error.code");
  return code;
}

function assignment(
  observation: CommandObservation,
  label: string,
): JsonObject {
  const assignments = array(data(observation, label)["assignments"], "assignments");
  assert(assignments.length === 1, `${label} must expose one Assignment`);
  return object(assignments[0], `${label} Assignment`);
}

try {
  await step(
    {
      id: "00",
      pathStep: "从精确归档安装独立命令",
      action: "在隔离 Bun prefix 中全局安装唯一归档，并从安装结果解析公开命令。",
      expected: "安装成功、零运行时依赖，版本与归档一致。",
    },
    () => {
      assert(existsSync(archiveFile), "release archive is missing");
      assert(
        readFileSync(archiveFile).byteLength < 2_000_000,
        "release archive exceeds 2,000,000 bytes",
      );
      const environment: Record<string, string | undefined> = {
        ...process.env,
        BUN_INSTALL: installPrefix,
      };
      delete environment["BURN_GRAPH_VIEWER_DIR"];
      const started = performance.now();
      const installation = spawn(
        "bun",
        ["add", "--global", archiveFile],
        { cwd: testRoot, env: environment },
      );
      installMilliseconds = performance.now() - started;
      assert(
        installation.exitCode === 0,
        installation.stderr.trim() || "archive installation failed",
      );
      const bin = spawn("bun", ["pm", "bin", "--global"], {
        cwd: testRoot,
        env: environment,
      });
      assert(bin.exitCode === 0, bin.stderr.trim() || "global bin lookup failed");
      executable = path.join(bin.stdout.trim(), "burn-graph");
      assert(existsSync(executable), "installed burn-graph command is missing");
      installedPackage = path.dirname(realpathSync(executable));
      if (fault !== null) {
        executable = installFaultWrapper(testRoot, executable, fault);
      }
      const manifest = object(
        JSON.parse(
          readFileSync(path.join(installedPackage, "package.json"), "utf8"),
        ),
        "installed package.json",
      );
      assert(
        manifest["dependencies"] === undefined,
        "installed archive contains runtime dependencies",
      );
      const version = invoke(["--version"]);
      installedVersion = data(version, "version")["version"] as string;
      assertString(installedVersion, "installed version");
      assert(
        installedVersion === packageVersion,
        "installed version differs from the registered archive version",
      );
      const initialized = invoke(["init"]);
      assert(data(initialized, "init")["root"] === ".", "init root must be project-relative");
      return {
        value: undefined,
        observed: `已安装 ${installedVersion}；归档 ${readFileSync(archiveFile).byteLength} bytes；运行时依赖 0。`,
      };
    },
  );

  const discovery = await step(
    {
      id: "01",
      pathStep: "从根 Help 发现短日常循环",
      action: "仅执行安装命令的 root Help 与 authoring Help。",
      expected: "根命令严格为六个产品入口，旧执行兼容区不进入第一屏。",
    },
    () => {
      const rootHelp = invoke(["--help"]);
      const rootData = data(rootHelp, "root Help");
      const commandNames = array(rootData["commands"], "root Help commands")
        .map((entry) => object(entry, "root Help command")["name"]);
      jsonEqual(
        commandNames,
        ["init", "goal", "graph", "work", "inspect", "help"],
        "root Help commands",
      );
      assert(!commandNames.includes("run"), "root Help exposed compatibility run");
      const topicNames = array(rootData["topics"], "root Help topics")
        .map((entry) => object(entry, "root Help topic")["name"]);
      assert(topicNames.includes("authoring"), "authoring topic is missing");
      const authoring = invoke(["help", "authoring"]);
      const content = object(
        data(authoring, "authoring Help")["content"],
        "authoring content",
      );
      assert(
        content["schema"] === "burn-graph graph schema",
        "authoring Help omits the schema command",
      );
      const sequence = strings(content["sequence"], "authoring sequence");
      assert(
        sequence.includes("burn-graph goal start <graph>"),
        "authoring Help omits goal start",
      );
      return {
        value: { rootHelp, authoring },
        observed: `根 Help 顺序为 ${commandNames.join(" → ")}；authoring 主题给出 ${sequence.length} 步闭环。`,
      };
    },
  );
  void discovery;

  const authoredGraph = await step(
    {
      id: "02",
      pathStep: "从完整 Schema 与 decision 示例创作 Graph",
      action: "请求 graph schema 与 graph example decision，并只改写公开示例的项目标识与目标。",
      expected: "Schema 覆盖 GraphSpec v1/v2/v3；示例完整，不需要源码文档。",
    },
    () => {
      const schema = invoke(["graph", "schema"]);
      const schemaData = data(schema, "graph schema");
      jsonEqual(
        schemaData["acceptedGraphSpecVersions"],
        [1, 2, 3],
        "accepted GraphSpec versions",
      );
      const jsonSchema = object(schemaData["jsonSchema"], "GraphSpec JSON Schema");
      assert(
        array(jsonSchema["oneOf"], "GraphSpec schema oneOf").length === 3,
        "GraphSpec schema must define v1, v2, and v3",
      );
      const example = invoke(["graph", "example", "decision"]);
      const exampleData = data(example, "decision example");
      const graph = object(exampleData["graph"], "decision graph");
      const adapted: JsonObject = {
        ...graph,
        id: "up11-decision",
        title: "UP11 installed authoring decision",
        goal: "Complete one decision using only installed Help.",
      };
      writeFileSync(
        path.join(projectRoot, "graph.json"),
        `${JSON.stringify(adapted, null, 2)}\n`,
        { mode: 0o600 },
      );
      return {
        value: adapted,
        observed: `Schema 接受 v1/v2/v3；decision 示例含 ${array(adapted["nodes"], "authored nodes").length} 个完整节点，已保存为 graph.json。`,
      };
    },
  );

  await step(
    {
      id: "03",
      pathStep: "文件与 stdin 等价，坏输入先判红",
      action: "分别验证 graph.json 和等价 stdin；再提交 malformed、绝对、父级与 symlink 逃逸输入。",
      expected: "正常结果等价；四类坏输入均返回单个有界错误且不改变 Graph 列表。",
    },
    () => {
      const fromFile = invoke([
        "graph",
        "validate",
        "--input",
        "graph.json",
      ]);
      const fromStdin = invoke(
        ["graph", "validate", "--input", "-"],
        { stdin: JSON.stringify(authoredGraph) },
      );
      jsonEqual(
        data(fromFile, "file validation"),
        data(fromStdin, "stdin validation"),
        "file/stdin validation",
      );
      const before = invoke(["graph", "list"]);
      const outsideFile = path.join(testRoot, "outside.json");
      writeFileSync(outsideFile, `${JSON.stringify(authoredGraph)}\n`, {
        mode: 0o600,
      });
      symlinkSync(outsideFile, path.join(projectRoot, "escape.json"));
      const malformed = invoke(
        ["graph", "apply", "--input", "-"],
        { stdin: "{\"schemaVersion\":", expectOk: false },
      );
      assert(errorCode(malformed) === "INVALID_JSON", "malformed JSON must judge red");
      for (const input of [
        outsideFile,
        "../outside.json",
        "escape.json",
      ]) {
        const rejected = invoke(
          ["graph", "apply", "--input", input],
          { expectOk: false },
        );
        assert(
          errorCode(rejected) === "INVALID_INPUT_PATH",
          `${input} must be rejected before mutation`,
        );
      }
      const after = invoke(["graph", "list"]);
      jsonEqual(before.envelope["data"], after.envelope["data"], "Graph list");
      return {
        value: undefined,
        observed: "文件/stdin 规范化结果相同；malformed=INVALID_JSON，绝对/父级/symlink=INVALID_INPUT_PATH，Graph 列表未变。",
      };
    },
  );

  const started = await step(
    {
      id: "04",
      pathStep: "应用 Graph 并用默认 Actor 领取 Assignment",
      action: "应用项目相对 graph.json，执行 run start（不传 Actor），随后执行 next。",
      expected: "默认 Actor 为 primary；start/next 指向同一完整 AssignmentPacket 与精确 done 命令。",
    },
    () => {
      const applied = invoke(["graph", "apply", "--input", "graph.json"]);
      assert(
        data(applied, "graph apply")["path"] ===
          ".burn/graph/graphs/up11-decision.json",
        "graph apply returned a non-project-relative path",
      );
      const start = invoke(["run", "start", "up11-decision"]);
      assert(data(start, "run start")["actorId"] === "primary", "default Actor must be primary");
      const first = assignment(start, "run start");
      const next = invoke(["next"]);
      assert(data(next, "next")["actorId"] === "primary", "next default Actor must be primary");
      const resumed = assignment(next, "next");
      assert(
        resumed["assignmentId"] === first["assignmentId"],
        "next must preserve the active Assignment",
      );
      const node = object(first["node"], "Assignment node");
      const prompt = object(node["prompt"], "Assignment prompt");
      assertString(prompt["objective"], "Assignment prompt objective");
      for (const field of [
        "instructions",
        "mustRead",
        "doneWhen",
        "lockedContracts",
        "writablePaths",
        "forbidden",
        "runtime",
      ]) {
        array(prompt[field], `Assignment prompt ${field}`);
      }
      const assignmentId = first["assignmentId"];
      assertString(assignmentId, "Assignment ID");
      const returnProtocol = object(first["returnProtocol"], "return protocol");
      assert(
        returnProtocol["complete"] ===
          `burn-graph work done --assignment ${assignmentId} --input -`,
        "Assignment complete command is not exact",
      );
      return {
        value: { assignmentId },
        observed: `Actor=primary；Assignment=${assignmentId}；完整 prompt contract 与精确 done 回传命令可见。`,
      };
    },
  );

  await step(
    {
      id: "05",
      pathStep: "通过 done 收敛并由只读快照复核",
      action: "按 Assignment 返回协议从 stdin 提交 pass，随后读取 inspect run、events 与 current。",
      expected: "done 与独立只读快照均显示 completed；事件包含持久 node.completed；Actor 无残留 Assignment。",
    },
    () => {
      const completed = invoke(
        [
          "done",
          "--assignment",
          started.assignmentId,
          "--input",
          "-",
        ],
        {
          stdin: JSON.stringify({
            summary: "Installed Help decision accepted.",
            evidence: ["UP11 synthetic acceptance"],
            route: "pass",
          }),
        },
      );
      assert(data(completed, "done")["state"] === "completed", "done did not complete the Run");
      const snapshot = invoke(["inspect", "run", "up11-decision"]);
      const summary = object(data(snapshot, "inspect run")["summary"], "Run summary");
      assert(summary["status"] === "completed", "snapshot is not completed");
      const events = invoke([
        "inspect",
        "events",
        "up11-decision",
        "--after",
        "0",
        "--limit",
        "100",
      ]);
      const durableEvents = array(events.envelope["data"], "durable events");
      assert(
        durableEvents.some(
          (entry) => object(entry, "event")["type"] === "node.completed",
        ),
        "durable events omit node.completed",
      );
      const current = invoke(["current"]);
      assert(
        array(data(current, "current")["assignments"], "current assignments")
          .length === 0,
        "completed Actor still owns an Assignment",
      );
      return {
        value: undefined,
        observed: `done state=completed；snapshot status=completed；${durableEvents.length} 条持久事件可见；current assignments=0。`,
      };
    },
  );

  await step(
    {
      id: "06",
      pathStep: "从 template show 直接复用完整输入",
      action: "读取 delivery exampleInput，分别以项目文件和 stdin 执行 template instantiate。",
      expected: "exampleInput 无缺字段；两种输入生成相同 Graph，第二次为幂等 replay。",
    },
    () => {
      const shown = invoke(["template", "show", "delivery"]);
      const exampleInput = object(
        data(shown, "template show")["exampleInput"],
        "template exampleInput",
      );
      assert(exampleInput["schemaVersion"] === 1, "template exampleInput version is missing");
      const context = object(exampleInput["context"], "template context");
      for (const field of [
        "mustRead",
        "lockedContracts",
        "writablePaths",
        "forbidden",
        "runtime",
      ]) {
        array(context[field], `template context ${field}`);
      }
      writeFileSync(
        path.join(projectRoot, "template.json"),
        `${JSON.stringify(exampleInput, null, 2)}\n`,
        { mode: 0o600 },
      );
      const fromFile = invoke([
        "template",
        "instantiate",
        "delivery",
        "--input",
        "template.json",
      ]);
      const fromStdin = invoke(
        [
          "template",
          "instantiate",
          "delivery",
          "--input",
          "-",
        ],
        { stdin: JSON.stringify(exampleInput) },
      );
      jsonEqual(
        data(fromFile, "template file")["graphs"],
        data(fromStdin, "template stdin")["graphs"],
        "template file/stdin Graphs",
      );
      assert(data(fromStdin, "template stdin")["replayed"] === true, "template stdin must replay");
      return {
        value: undefined,
        observed: "delivery exampleInput 完整；文件/stdin 生成同一 Graph；第二次 replayed=true。",
      };
    },
  );

  await step(
    {
      id: "07",
      pathStep: "核对安装包自包含资产",
      action: "比较包内 Help/Schema 与公开命令响应，并解析 README 的全部相对链接。",
      expected: "生成资产与命令一致，README 零断链，包内无 Product Private 路径。",
    },
    () => {
      const packagedHelp = object(
        JSON.parse(
          readFileSync(
            path.join(installedPackage, "help", "root.json"),
            "utf8",
          ),
        ),
        "packaged root Help",
      );
      jsonEqual(packagedHelp, invoke(["--help"]).envelope, "packaged root Help");
      const packagedSchema = object(
        JSON.parse(
          readFileSync(
            path.join(installedPackage, "schema", "graph-spec.json"),
            "utf8",
          ),
        ),
        "packaged Graph schema",
      );
      jsonEqual(
        packagedSchema,
        invoke(["graph", "schema"]).envelope,
        "packaged Graph schema",
      );
      const readme = readFileSync(
        path.join(installedPackage, "README.md"),
        "utf8",
      );
      let relativeLinks = 0;
      for (const match of readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
        const target = match[1];
        assertString(target, "README link");
        if (
          target.startsWith("#") ||
          /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)
        ) {
          continue;
        }
        relativeLinks += 1;
        assert(
          existsSync(path.resolve(installedPackage, target)),
          `broken packaged README link: ${target}`,
        );
      }
      const listing = spawn("tar", ["-tzf", archiveFile], {
        cwd: testRoot,
      });
      assert(listing.exitCode === 0, "archive listing failed");
      assert(
        !/(?:^|\/)(?:privacy|bdd|milestones|slices|issues|feedback)(?:\/|$)|product\.md/mu
          .test(listing.stdout),
        "archive contains Product Private paths",
      );
      return {
        value: undefined,
        observed: `Help/Schema 与包内生成资产逐字节语义一致；${relativeLinks} 个 README 相对链接全部存在；无 Product Private 路径。`,
      };
    },
  );

  assert(installMilliseconds < 20_000, "archive installation exceeded 20 seconds");
  assert(
    Math.max(...commandDurations) < 1_000,
    "one installed CLI command exceeded 1 second",
  );
  assert(maximumOutputBytes <= 256 * 1024, "public output exceeded 256 KiB");
} catch (error) {
  const summary = publicMessage(error, privateRoots);
  failure = {
    stepId: error instanceof UserPathFailure ? error.stepId : "00",
    summary,
    recovery:
      "保留失败 Evidence，修复首个偏离后从精确归档重新执行完整 UP11。",
  };
} finally {
  const finishedAt = now();
  if (fault !== null) {
    const expectedStep = FAULTS[fault]!.step;
    const resolvedTestRoot = path.resolve(testRoot);
    assert(
      resolvedTestRoot.startsWith(path.join(tmpdir(), "burn-graph-up11-")),
      "refusing to remove an unexpected test directory",
    );
    rmSync(resolvedTestRoot, { recursive: true, force: true });
    const caught = failure !== null && failure.stepId === expectedStep;
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        ok: caught,
        command: "verify.up11.fault",
        data: {
          fault,
          expectedStep,
          observedStep: failure?.stepId ?? null,
          observed: failure?.summary ?? "the User Path passed a wrong product",
        },
      })}\n`,
    );
    // A Gate that stays green against a semantically wrong product is the defect,
    // so this is the one place where "the run passed" is the failure.
    process.exitCode = caught ? 0 : 1;
  } else {
  if (steps.length === 0) {
    steps.push({
      id: "00",
      pathStep: "准备精确归档",
      action: "解析归档与 Evidence 入口。",
      expected: "归档存在且测试入口可执行。",
      observed: `失败：${failure?.summary ?? "unknown setup failure"}`,
      startedAt: runStartedAt,
      finishedAt,
      status: "failed",
    });
  }
  const status: RunStatus = failure === null ? "passed" : "failed";
  const archiveBytes = existsSync(archiveFile)
    ? readFileSync(archiveFile).byteLength
    : 0;
  const performanceEvidence = [
    {
      name: "隔离全局安装",
      value: Math.round(installMilliseconds),
      unit: "ms",
      budget: "< 20000 ms",
      status:
        installMilliseconds > 0 && installMilliseconds < 20_000
          ? "passed"
          : status,
    },
    {
      name: "最慢公开 CLI 命令",
      value:
        commandDurations.length === 0
          ? 0
          : Math.round(Math.max(...commandDurations) * 100) / 100,
      unit: "ms",
      budget: "< 1000 ms",
      status:
        commandDurations.length > 0 &&
        Math.max(...commandDurations) < 1_000
          ? "passed"
          : status,
    },
    {
      name: "最大公开输出",
      value: maximumOutputBytes,
      unit: "bytes",
      budget: "<= 262144 bytes",
      status: maximumOutputBytes <= 256 * 1024 ? "passed" : "failed",
    },
    {
      name: "发布归档",
      value: archiveBytes,
      unit: "bytes",
      budget: "< 2000000 bytes",
      status:
        archiveBytes > 0 && archiveBytes < 2_000_000
          ? "passed"
          : "failed",
    },
  ] satisfies readonly {
    readonly name: string;
    readonly value: number;
    readonly unit: string;
    readonly budget: string;
    readonly status: RunStatus;
  }[];
  const diagnostics = failure === null
    ? [
        {
          category: "artifact-boundary",
          status: "passed" as const,
          summary:
            "用户动作只调用隔离全局安装后的公开 burn-graph 命令与包内公开资产。",
        },
        {
          category: "persistence",
          status: "passed" as const,
          summary:
            "GraphSpec、Run snapshot 与 events 均由项目本地安装实例持久化并从只读入口复核。",
        },
        {
          category: "privacy",
          status: "passed" as const,
          summary:
            "使用合成数据；每个 CLI envelope 均通过大小、单行 JSON 与绝对路径扫描。",
        },
      ]
    : [
        {
          category: "first-divergence",
          status: "failed" as const,
          summary: failure.summary,
        },
      ];
  const manifest = {
    schemaVersion: 1,
    runId: `up11-dev1-${Date.now()}`,
    userPathId: "UP11",
    version: installedVersion,
    artifactRef: `${path.basename(archiveFile)}#sha256=${
      existsSync(archiveFile) ? sha256(archiveFile) : "missing"
    }`,
    environmentRef: `local-test; Bun ${Bun.version}; isolated global archive install`,
    actorRef:
      "archive-only deterministic CLI blackbox harness; independent AI review remains a separate Gate",
    fixtureRef:
      "installed decision example adapted to synthetic up11-decision plus installed delivery template input",
    startedAt: runStartedAt,
    finishedAt,
    status,
    steps,
    performance: performanceEvidence,
    diagnostics,
    failure,
  };
  const manifestFile = path.join(testRoot, "up11-evidence-input.json");
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  mkdirSync(outputDirectory, { recursive: true });
  const generated = spawn(
    "bun",
    [
      evidenceGenerator,
      "--input",
      manifestFile,
      "--output",
      outputDirectory,
    ],
    { cwd: repositoryRoot },
  );
  if (generated.exitCode !== 0) {
    failure ??= {
      stepId: "evidence",
      summary: publicMessage(generated.stderr, privateRoots),
      recovery: "修复 Evidence 输入或生成器后重跑完整 UP11。",
    };
  }
  const resolvedTestRoot = path.resolve(testRoot);
  assert(
    resolvedTestRoot.startsWith(path.join(tmpdir(), "burn-graph-up11-")),
    "refusing to remove an unexpected test directory",
  );
  rmSync(resolvedTestRoot, { recursive: true, force: true });
  }
}

if (fault !== null) {
  // The verdict was already written by the self-test branch above.
} else if (failure !== null) {
  process.stderr.write(
    `${JSON.stringify({
      schemaVersion: 1,
      ok: false,
      command: "verify.up11",
      error: {
        code: "UP11_FAILED",
        message: failure.summary,
        retryable: true,
      },
    })}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      ok: true,
      command: "verify.up11",
      data: {
        version: installedVersion,
        artifact: `${path.basename(archiveFile)}#sha256=${sha256(archiveFile)}`,
        output: path.basename(outputDirectory),
        steps: steps.length,
        maximumOutputBytes,
      },
    })}\n`,
  );
}
