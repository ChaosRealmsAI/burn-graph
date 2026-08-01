// Purpose: Replay UP15 through an isolated installation of one exact archive.
// Usage: bun tests/e2e/user-paths/UP15-goal-graph-work.e2e.ts [--archive <tgz>] [--output <directory>]
//        bun tests/e2e/user-paths/UP15-goal-graph-work.e2e.ts --fault execution-self-verifies

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type RunStatus = "passed" | "failed" | "blocked";
type JsonObject = Record<string, unknown>;

interface Observation {
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
const packageManifest = object(
  JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")),
  "package.json",
);
const packageVersion = packageManifest["version"];
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

function selectedFault(): "execution-self-verifies" | null {
  const inputs = Bun.argv.slice(2);
  const index = inputs.indexOf("--fault");
  if (index === -1) return null;
  if (inputs[index + 1] !== "execution-self-verifies") {
    throw new Error("--fault requires execution-self-verifies");
  }
  return "execution-self-verifies";
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
    "UP15-goal-graph-work",
  ),
);
const evidenceGenerator = path.join(
  repositoryRoot,
  "scripts",
  "verify",
  "e2e-evidence.ts",
);
const fault = selectedFault();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertString(value: unknown, label: string): asserts value is string {
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

function now(): string {
  return new Date().toISOString();
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function publicMessage(error: unknown, roots: readonly string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const root of roots)
    message = message.replaceAll(root, "<isolated-path>");
  return message
    .replaceAll(/\/Users\/[^\s"]+/gu, "<isolated-path>")
    .replaceAll(/\/home\/[^\s"]+/gu, "<isolated-path>")
    .replaceAll(/\/var\/folders\/[^\s"]+/gu, "<isolated-path>");
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

// This wrapper preserves the process boundary and envelope while making one
// semantic result wrong. The UP15 Gate must reject it at the evidence-progress step.
function installFaultWrapper(directory: string, real: string): string {
  const script = path.join(directory, "burn-graph-up15-fault.ts");
  writeFileSync(
    script,
    `#!/usr/bin/env bun
const real = ${JSON.stringify(real)};
const args = Bun.argv.slice(2);
const result = Bun.spawnSync([real, ...args], {
  stdin: "inherit",
  stdout: "pipe",
  stderr: "pipe",
});
let stdout = result.stdout.toString();
if (result.exitCode === 0 && args.includes("goal") && args.includes("show")) {
  try {
    const envelope = JSON.parse(stdout.trim());
    const progress = envelope?.data?.goal?.progress;
    if (progress?.evidence?.claimed > 0 && progress?.evidence?.verified === 0) {
      progress.percent = 100;
      progress.evidence.verified = progress.evidence.claimed;
      stdout = JSON.stringify(envelope) + "\\n";
    }
  } catch {
    // Non-JSON output remains unchanged and will be rejected by the harness.
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

function prompt(objective: string): JsonObject {
  return {
    objective,
    instructions: ["Use only current externally inspectable artifacts."],
    mustRead: ["UP15"],
    doneWhen: ["The assigned evidence has a current external artifact."],
    outputSchema: null,
    role: "UP15 synthetic Actor",
    lockedContracts: ["Execution cannot verify its own evidence."],
    writablePaths: [],
    forbidden: ["Do not rewrite the evidence contract silently."],
    runtime: ["burn-graph goal show up15-goal:run"],
  };
}

const graph: JsonObject = {
  schemaVersion: 3,
  id: "up15-goal",
  title: "UP15 Goal Graph Work",
  goal: {
    objective:
      "Produce a result, adapt its evidence contract, repair it, and prove it independently.",
    boundaries: [
      "Keep Goal state canonical.",
      "Treat self-reported progress as context rather than proof.",
    ],
    successEvidence: [
      {
        id: "E1",
        description: "The requested result exists.",
        acceptance: ["A public artifact demonstrates the result."],
        oracle: "An independent Actor inspects artifact://up15/result.",
      },
      {
        id: "E2",
        description: "The result survives its public read path.",
        acceptance: ["A fresh process reads the same result."],
        oracle: "The installed public CLI returns the persisted Goal snapshot.",
      },
    ],
    review: {
      required: true,
      independentActor: true,
      criteria: [
        "Judge every effective evidence item and preserve revise Attempts.",
      ],
    },
  },
  revision: 1,
  maxActive: 1,
  nodes: [
    {
      id: "start",
      type: "start",
      title: "Start",
      prompt: prompt(""),
      next: [{ to: "work" }],
      maxAttempts: 1,
      actorHint: null,
      tags: [],
    },
    {
      id: "work",
      type: "task",
      title: "Produce or repair result",
      prompt: prompt(
        "Produce the result or repair the current Review finding.",
      ),
      work: { kind: "execute", evidence: ["E1", "E2"], reviewOf: [] },
      next: [{ to: "review" }],
      maxAttempts: 3,
      actorHint: "maker",
      tags: ["execute"],
    },
    {
      id: "review",
      type: "decision",
      title: "Independent Review",
      prompt: prompt("Judge all effective evidence and return pass or revise."),
      work: {
        kind: "review",
        evidence: ["E1", "E2"],
        reviewOf: ["work"],
      },
      next: [
        { to: "end", route: "pass" },
        { to: "work", route: "revise", maxTraversals: 2 },
      ],
      maxAttempts: 3,
      actorHint: "reviewer",
      tags: ["review"],
    },
    {
      id: "end",
      type: "end",
      title: "Goal complete",
      prompt: prompt(""),
      next: [],
      maxAttempts: 1,
      actorHint: null,
      tags: [],
    },
  ],
};

const testRoot = mkdtempSync(path.join(tmpdir(), "burn-graph-up15-"));
const installPrefix = path.join(testRoot, "bun-prefix");
const projectRoot = path.join(testRoot, "project");
mkdirSync(projectRoot, { recursive: true });
const privateRoots = [repositoryRoot, testRoot];
const steps: StepEvidence[] = [];
const commandDurations: number[] = [];
let maximumOutputBytes = 0;
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
  options: { readonly stdin?: string; readonly expectOk?: boolean } = {},
): Observation {
  assert(executable.length > 0, "installed executable is unavailable");
  const result = spawn(executable, ["--root", ".", ...args], {
    cwd: projectRoot,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  });
  const expectOk = options.expectOk ?? true;
  const serialized = (expectOk ? result.stdout : result.stderr).trim();
  assert(
    result.exitCode === (expectOk ? 0 : 1),
    `burn-graph ${args.join(" ")} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`,
  );
  assert(serialized.length > 0, "CLI returned no JSON envelope");
  assert(
    serialized.split("\n").length === 1,
    "CLI returned multiple envelopes",
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
  assert(envelope["ok"] === expectOk, "CLI ok disagrees with exit status");
  commandDurations.push(result.milliseconds);
  maximumOutputBytes = Math.max(maximumOutputBytes, bytes);
  return { envelope, milliseconds: result.milliseconds, bytes };
}

function data(observation: Observation, label: string): JsonObject {
  return object(observation.envelope["data"], `${label}.data`);
}

function errorCode(observation: Observation): string {
  const error = object(observation.envelope["error"], "error");
  const code = error["code"];
  assertString(code, "error.code");
  return code;
}

function assignment(observation: Observation, label: string): JsonObject {
  const schedule = data(observation, label);
  const assignments = array(schedule["assignments"], "assignments");
  assert(
    assignments.length === 1,
    `${label} must contain one Assignment; schedule=${JSON.stringify({
      state: schedule["state"],
      remainingReadyCount: schedule["remainingReadyCount"],
      remainingReady: schedule["remainingReady"],
      runs: schedule["runs"],
      assignmentOutput: schedule["assignmentOutput"],
    })}`,
  );
  return object(assignments[0], `${label} Assignment`);
}

function assignmentId(value: JsonObject, label: string): string {
  const id = value["assignmentId"];
  assertString(id, `${label} assignmentId`);
  return id;
}

function goalState(observation: Observation, label: string): JsonObject {
  return object(data(observation, label)["goal"], `${label} goal`);
}

try {
  await step(
    {
      id: "00",
      pathStep: "从精确归档安装并初始化",
      action: "在隔离 Bun prefix 安装唯一归档，再调用公开 init。",
      expected: "安装版本与归档一致，项目运行目录初始化成功。",
    },
    () => {
      assert(existsSync(archiveFile), "release archive is missing");
      const environment: Record<string, string | undefined> = {
        ...process.env,
        BUN_INSTALL: installPrefix,
      };
      const started = performance.now();
      const installation = spawn("bun", ["add", "--global", archiveFile], {
        cwd: testRoot,
        env: environment,
      });
      installMilliseconds = performance.now() - started;
      assert(
        installation.exitCode === 0,
        installation.stderr || "install failed",
      );
      const bin = spawn("bun", ["pm", "bin", "--global"], {
        cwd: testRoot,
        env: environment,
      });
      assert(bin.exitCode === 0, bin.stderr || "global bin lookup failed");
      executable = path.join(bin.stdout.trim(), "burn-graph");
      assert(existsSync(executable), "installed command is missing");
      const realExecutable = realpathSync(executable);
      if (fault !== null)
        executable = installFaultWrapper(testRoot, realExecutable);
      const version = invoke(["--version"]);
      installedVersion = data(version, "version")["version"] as string;
      assert(installedVersion === packageVersion, "installed version drifted");
      invoke(["init"]);
      return {
        value: undefined,
        observed: `已安装并初始化 burn-graph ${installedVersion}。`,
      };
    },
  );

  await step(
    {
      id: "01",
      pathStep: "从公开 Help 发现 Goal 与 Work，并登记证据契约",
      action: "读取 Goal/Work Help，用 stdin 验证并应用 GraphSpec v3。",
      expected:
        "公开入口可发现；Graph 在启动前已明确目标、边界、证据、Oracle 与 Owner Work。",
    },
    () => {
      const rootHelp = data(invoke(["--help"]), "root Help");
      const commands = array(rootHelp["commands"], "root commands").map(
        (entry) => object(entry, "root command")["name"],
      );
      assert(
        commands.includes("goal") && commands.includes("work"),
        "Goal/Work Help missing",
      );
      const input = JSON.stringify(graph);
      const validated = invoke(["graph", "validate", "--input", "-"], {
        stdin: input,
      });
      assert(
        data(validated, "validate")["valid"] === true,
        "GraphSpec v3 is invalid",
      );
      invoke(["graph", "apply", "--input", "-"], { stdin: input });
      const evidence = array(
        object(graph["goal"], "graph goal")["successEvidence"],
        "success evidence",
      );
      return {
        value: undefined,
        observed: `Help 暴露 Goal/Work；启动前已登记 ${evidence.length} 项证据及外部 Oracle。`,
      };
    },
  );

  const execution = await step(
    {
      id: "02",
      pathStep: "启动 Goal 并领取完整 Work packet",
      action: "用 maker 启动固定 Run，检查目标快照、证据 Owner 与返回协议。",
      expected: "首个 Work 同时带 Goal、完整 prompt、证据责任和精确回传命令。",
    },
    () => {
      const started = invoke([
        "goal",
        "start",
        "up15-goal",
        "--actor",
        "maker",
        "--run-id",
        "up15-goal:run",
      ]);
      const work = assignment(started, "goal start");
      const node = object(work["node"], "execution node");
      const workContract = object(node["work"], "execution work contract");
      assert(
        JSON.stringify(workContract["evidence"]) ===
          JSON.stringify(["E1", "E2"]),
        "execution evidence ownership drifted",
      );
      const snapshot = object(
        object(work["graph"], "assignment graph")["goalState"],
        "assignment goalState",
      );
      const progress = object(snapshot["progress"], "initial progress");
      assert(progress["percent"] === 0, "new Goal must start at zero");
      return {
        value: { assignmentId: assignmentId(work, "execution") },
        observed:
          "maker 获得完整 Work packet；E1/E2 Owner 明确；Goal progress=0%。",
      };
    },
  );

  await step(
    {
      id: "03",
      pathStep: "记录执行进度与证据，但不自证 Goal",
      action:
        "先尝试 checkpoint 自报 85% 并确认判红，再只记录事实，完成 Work 并申领 E1/E2。",
      expected:
        "模型百分比被拒绝；Work 已执行、证据已 claimed，但 verified=0 且 Goal 仍为 0%。",
    },
    () => {
      const authoredProgress = invoke(
        [
          "work",
          "checkpoint",
          "--assignment",
          execution.assignmentId,
          "--input",
          "-",
        ],
        {
          stdin: JSON.stringify({
            summary: "The model estimates that execution is 85% complete.",
            progress: 85,
            artifacts: [],
          }),
          expectOk: false,
        },
      );
      assert(
        errorCode(authoredProgress) === "DERIVED_PROGRESS_READ_ONLY",
        "GraphSpec v3 accepted model-authored Goal progress",
      );
      invoke(
        [
          "work",
          "checkpoint",
          "--assignment",
          execution.assignmentId,
          "--input",
          "-",
        ],
        {
          stdin: JSON.stringify({
            summary: "Initial result is ready for external inspection.",
            progress: null,
            artifacts: ["artifact://up15/result"],
            record: {
              facts: ["The synthetic public artifact exists."],
              decisions: [],
              blockers: [],
              artifacts: ["artifact://up15/result"],
              next: "Claim evidence and request Review.",
            },
          }),
        },
      );
      const completed = invoke(
        [
          "work",
          "done",
          "--assignment",
          execution.assignmentId,
          "--input",
          "-",
        ],
        {
          stdin: JSON.stringify({
            summary: "Produced the public result and persisted its read path.",
            evidence: ["synthetic public observation"],
            record: {
              facts: [
                "The artifact exists and a fresh process can read the Run.",
              ],
              decisions: [
                {
                  summary: "Submit both initial evidence claims.",
                  reason:
                    "Their declared external observations are now available.",
                },
              ],
              blockers: [],
              artifacts: [
                "artifact://up15/result",
                "artifact://up15/restart-read",
              ],
              next: "Independent Review.",
            },
            evidenceClaims: [
              {
                evidenceId: "E1",
                summary: "The public result artifact exists.",
                artifacts: ["artifact://up15/result"],
              },
              {
                evidenceId: "E2",
                summary: "A fresh public process read the persisted Run.",
                artifacts: ["artifact://up15/restart-read"],
              },
            ],
          }),
        },
      );
      assert(
        array(data(completed, "execution done")["assignments"], "assignments")
          .length === 0,
        "the same Actor must not receive Review Work",
      );
      const shown = goalState(
        invoke(["goal", "show", "up15-goal:run"]),
        "claimed Goal",
      );
      const progress = object(shown["progress"], "claimed progress");
      const evidence = object(
        progress["evidence"],
        "claimed evidence progress",
      );
      const work = object(progress["work"], "claimed Work progress");
      assert(progress["percent"] === 0, "execution self-verified the Goal");
      assert(
        evidence["claimed"] === 2 && evidence["verified"] === 0,
        "claimed and verified evidence must remain distinct",
      );
      assert(
        work["executed"] === 1 && work["verified"] === 0,
        "executed and verified Work must remain distinct",
      );
      return {
        value: undefined,
        observed:
          "checkpoint 85%=DERIVED_PROGRESS_READ_ONLY；Work executed=1；evidence claimed=2、verified=0；Goal=0%。",
      };
    },
  );

  await step(
    {
      id: "04",
      pathStep: "拒绝执行者领取自己的 Review",
      action:
        "记录 runtimeRevision，让 maker 请求下一项 Work，再复读 Goal 与事件。",
      expected:
        "返回零 Assignment，且不创建 Attempt、不增加事件、不改变 revision。",
    },
    () => {
      const before = data(
        invoke(["goal", "show", "up15-goal:run"]),
        "before self-review",
      );
      const revision = before["runtimeRevision"];
      const eventsBefore = array(
        invoke([
          "inspect",
          "events",
          "up15-goal:run",
          "--after",
          "0",
          "--limit",
          "100",
        ]).envelope["data"],
        "events before self-review",
      );
      const requested = invoke([
        "work",
        "next",
        "--actor",
        "maker",
        "--graph",
        "up15-goal:run",
      ]);
      assert(
        array(
          data(requested, "self-review next")["assignments"],
          "self-review assignments",
        ).length === 0,
        "maker received its own Review",
      );
      const after = data(
        invoke(["goal", "show", "up15-goal:run"]),
        "after self-review",
      );
      const eventsAfter = array(
        invoke([
          "inspect",
          "events",
          "up15-goal:run",
          "--after",
          "0",
          "--limit",
          "100",
        ]).envelope["data"],
        "events after self-review",
      );
      assert(
        after["runtimeRevision"] === revision,
        "rejected claim changed runtimeRevision",
      );
      assert(
        eventsAfter.length === eventsBefore.length,
        "rejected claim appended an event",
      );
      return {
        value: undefined,
        observed: `maker assignments=0；runtimeRevision=${String(revision)}；事件数保持 ${eventsAfter.length}。`,
      };
    },
  );

  const repair = await step(
    {
      id: "05",
      pathStep: "独立 Review 判 revise 并进入有界修复",
      action:
        "reviewer-a 领取 Review，针对 E2 返回 blocking finding 与 revise。",
      expected:
        "Review Attempt 被持久化，只打开声明的有界重做路径，并返回完整修复 Work。",
    },
    () => {
      const scheduled = invoke([
        "work",
        "next",
        "--actor",
        "reviewer-a",
        "--graph",
        "up15-goal:run",
      ]);
      const reviewWork = assignment(scheduled, "first Review");
      const reviewed = invoke(
        [
          "work",
          "done",
          "--assignment",
          assignmentId(reviewWork, "first Review"),
          "--input",
          "-",
        ],
        {
          stdin: JSON.stringify({
            summary: "The restart observation is stale and requires repair.",
            evidence: ["artifact://up15/review-a"],
            record: {
              facts: ["E1 is current; E2 has a stale observation."],
              decisions: [
                {
                  summary: "Return revise.",
                  reason:
                    "The declared E2 Oracle does not yet establish the recovery result.",
                },
              ],
              blockers: ["Refresh the public recovery observation."],
              artifacts: ["artifact://up15/review-a"],
              next: "Execute the bounded repair Work.",
            },
            evidenceClaims: [],
            verdict: {
              decision: "revise",
              summary: "E2 needs a current repair observation.",
              evidence: ["E1"],
              findings: [
                {
                  severity: "blocking",
                  summary: "Refresh the stale public recovery observation.",
                  evidenceId: "E2",
                },
              ],
            },
            route: "revise",
          }),
        },
      );
      const repairWork = assignment(reviewed, "revise result");
      const node = object(repairWork["node"], "repair node");
      assert(
        node["id"] === "work",
        "revise escaped the declared bounded Work loop",
      );
      return {
        value: { assignmentId: assignmentId(repairWork, "repair") },
        observed:
          "reviewer-a 持久化 blocking finding；route=revise；唯一后继为 work Attempt 2。",
      };
    },
  );

  await step(
    {
      id: "06",
      pathStep: "动态追加证据并独立接受",
      action:
        "Review 揭示新事实后，planner 追加 E3 给已重新打开的 execution Work；先尝试自审，再由 contract-reviewer 接受并从新进程复读。",
      expected:
        "自审判红且不落状态；独立接受后 required=3，原证据不被改写，历史可见。",
    },
    () => {
      const proposed = invoke(
        [
          "goal",
          "amend",
          "up15-goal:run",
          "--actor",
          "planner",
          "--idempotency-key",
          "up15-add-e3",
          "--input",
          "-",
        ],
        {
          stdin: JSON.stringify({
            reason: "The first external Review exposed a recovery requirement.",
            changes: [
              {
                op: "add",
                ownerWorkId: "work",
                evidence: {
                  id: "E3",
                  description:
                    "The blocking finding is repaired through a repeated public Work Attempt.",
                  acceptance: [
                    "A repair artifact resolves the recorded finding.",
                  ],
                  oracle:
                    "A new independent reviewer inspects artifact://up15/repair.",
                },
              },
            ],
          }),
        },
      );
      const proposedGoal = object(
        data(proposed, "proposal")["goal"],
        "proposed goal",
      );
      const amendments = array(proposedGoal["amendments"], "amendments");
      const entry = object(amendments.at(-1), "amendment");
      const id = entry["amendmentId"];
      assertString(id, "amendment ID");
      const selfReview = invoke(
        [
          "goal",
          "review-amendment",
          id,
          "--actor",
          "planner",
          "--idempotency-key",
          "up15-self-review-e3",
          "--input",
          "-",
        ],
        {
          stdin: JSON.stringify({
            verdict: "accept",
            summary: "Invalid self review.",
          }),
          expectOk: false,
        },
      );
      assert(
        errorCode(selfReview) === "REVIEW_INDEPENDENCE_REQUIRED",
        "amendment self-review must be rejected",
      );
      invoke(
        [
          "goal",
          "review-amendment",
          id,
          "--actor",
          "contract-reviewer",
          "--idempotency-key",
          "up15-accept-e3",
          "--input",
          "-",
        ],
        {
          stdin: JSON.stringify({
            verdict: "accept",
            summary:
              "E3 strengthens the observed recovery result without weakening E1 or E2.",
          }),
        },
      );
      const restored = goalState(
        invoke(["goal", "show", "up15-goal:run"]),
        "restored Goal",
      );
      const evidence = array(restored["evidence"], "restored evidence");
      assert(
        JSON.stringify(
          evidence.map((item) => object(item, "evidence")["id"]),
        ) === JSON.stringify(["E1", "E2", "E3"]),
        "accepted amendment did not survive a fresh process",
      );
      assert(
        object(restored["progress"], "amended progress")["percent"] === 0,
        "amendment changed verified progress",
      );
      return {
        value: undefined,
        observed: `自审=${errorCode(selfReview)}；${id} 已独立接受；E1/E2/E3 与完整历史重启后可见。`,
      };
    },
  );

  await step(
    {
      id: "07",
      pathStep: "修复新增证据并由新 Reviewer 最终判定",
      action:
        "完成重复 Work 并重新申领 E1/E2、首次申领 E3；reviewer-b 覆盖全部证据返回 pass。",
      expected:
        "修复者不能领取最终 Review；新 Reviewer 的 pass 才使 Goal 达到 100%。",
    },
    () => {
      const repaired = invoke(
        ["work", "done", "--assignment", repair.assignmentId, "--input", "-"],
        {
          stdin: JSON.stringify({
            summary: "Refreshed the public recovery observation.",
            evidence: ["artifact://up15/repair"],
            record: {
              facts: [
                "The stale recovery observation is replaced by a current artifact.",
              ],
              decisions: [
                {
                  summary: "Keep the original claim history.",
                  reason: "The revise Attempt must remain auditable.",
                },
              ],
              blockers: [],
              artifacts: ["artifact://up15/repair"],
              next: "A new independent final Review.",
            },
            evidenceClaims: [
              {
                evidenceId: "E1",
                summary: "The repaired public result artifact exists.",
                artifacts: ["artifact://up15/result"],
              },
              {
                evidenceId: "E2",
                summary: "A fresh process read the repaired persisted Run.",
                artifacts: ["artifact://up15/restart-read"],
              },
              {
                evidenceId: "E3",
                summary: "The repair artifact resolves the blocking finding.",
                artifacts: ["artifact://up15/repair"],
              },
            ],
          }),
        },
      );
      assert(
        array(
          data(repaired, "repair done")["assignments"],
          "repair successor assignments",
        ).length === 0,
        "repairer received its own final Review",
      );
      const scheduled = invoke([
        "work",
        "next",
        "--actor",
        "reviewer-b",
        "--graph",
        "up15-goal:run",
      ]);
      const reviewWork = assignment(scheduled, "final Review");
      const passed = invoke(
        [
          "work",
          "done",
          "--assignment",
          assignmentId(reviewWork, "final Review"),
          "--input",
          "-",
        ],
        {
          stdin: JSON.stringify({
            summary:
              "Every effective evidence item passed its external Oracle.",
            evidence: ["artifact://up15/review-b"],
            record: {
              facts: [
                "E1, E2, and E3 are current and independently inspectable.",
              ],
              decisions: [
                {
                  summary: "Pass the Goal.",
                  reason:
                    "Every effective evidence item and the repair history satisfy the contract.",
                },
              ],
              blockers: [],
              artifacts: ["artifact://up15/review-b"],
              next: null,
            },
            evidenceClaims: [],
            verdict: {
              decision: "pass",
              summary: "All effective evidence is independently verified.",
              evidence: ["E1", "E2", "E3"],
              findings: [],
            },
            route: "pass",
          }),
        },
      );
      assert(
        data(passed, "final pass")["state"] === "completed",
        "pass did not complete Run",
      );
      const finalGoal = goalState(
        invoke(["goal", "show", "up15-goal:run"]),
        "final Goal",
      );
      const progress = object(finalGoal["progress"], "final progress");
      const evidence = object(progress["evidence"], "final evidence progress");
      assert(
        finalGoal["status"] === "satisfied",
        "final Goal is not satisfied",
      );
      assert(progress["percent"] === 100, "final Goal did not reach 100%");
      assert(
        evidence["required"] === 3 && evidence["verified"] === 3,
        "final Review did not cover every effective evidence item",
      );
      return {
        value: undefined,
        observed:
          "repairer 未获得 Review；reviewer-b 覆盖 E1/E2/E3；Goal satisfied=100%。",
      };
    },
  );

  await step(
    {
      id: "08",
      pathStep: "复核历史、终态与无残留 Work",
      action: "读取持久事件、Goal 和两位 Reviewer 的 current Work。",
      expected:
        "revise/pass 两个 Review Attempt 均保留，Run completed，Actor 无残留 Assignment。",
    },
    () => {
      const events = array(
        invoke([
          "inspect",
          "events",
          "up15-goal:run",
          "--after",
          "0",
          "--limit",
          "100",
        ]).envelope["data"],
        "final events",
      );
      const reviewCompletions = events.filter((entry) => {
        const event = object(entry, "event");
        return (
          event["type"] === "node.completed" && event["nodeId"] === "review"
        );
      });
      assert(
        reviewCompletions.length === 2,
        "revise/pass Review Attempts were not both preserved",
      );
      const routes = reviewCompletions.map(
        (entry) =>
          object(object(entry, "review event")["payload"], "review payload")[
            "route"
          ],
      );
      assert(
        JSON.stringify(routes) === JSON.stringify(["revise", "pass"]),
        "Review Attempt routes drifted",
      );
      for (const actor of ["maker", "reviewer-a", "reviewer-b"]) {
        const current = invoke(["work", "current", "--actor", actor]);
        assert(
          array(
            data(current, `${actor} current`)["assignments"],
            `${actor} assignments`,
          ).length === 0,
          `${actor} retained Work after completion`,
        );
      }
      return {
        value: undefined,
        observed: `持久 Review routes=${routes.join(" → ")}；Run completed；全部 Actor assignments=0。`,
      };
    },
  );

  assert(
    installMilliseconds < 20_000,
    "archive installation exceeded 20 seconds",
  );
  assert(
    Math.max(...commandDurations) < 1_000,
    "one public command exceeded 1 second",
  );
} catch (error) {
  const summary = publicMessage(error, privateRoots);
  failure = {
    stepId: error instanceof UserPathFailure ? error.stepId : "00",
    summary,
    recovery: "保留首个偏离，修复后从同一精确归档重放完整 UP15。",
  };
} finally {
  const finishedAt = now();
  if (fault !== null) {
    const caught = failure?.stepId === "03";
    const resolvedRoot = path.resolve(testRoot);
    assert(
      resolvedRoot.startsWith(path.join(tmpdir(), "burn-graph-up15-")),
      "refusing to remove an unexpected test directory",
    );
    rmSync(resolvedRoot, { recursive: true, force: true });
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        ok: caught,
        command: "verify.up15.fault",
        data: {
          fault,
          expectedStep: "03",
          observedStep: failure?.stepId ?? null,
          observed: failure?.summary ?? "the wrong product passed",
        },
      })}\n`,
    );
    process.exitCode = caught ? 0 : 1;
  } else {
    if (steps.length === 0) {
      steps.push({
        id: "00",
        pathStep: "准备精确归档",
        action: "解析归档与 Evidence 入口。",
        expected: "归档存在且黑盒入口可执行。",
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
    const manifest = {
      schemaVersion: 1,
      runId: `up15-dev2-${Date.now()}`,
      userPathId: "UP15",
      version: installedVersion,
      artifactRef: `${path.basename(archiveFile)}#sha256=${existsSync(archiveFile) ? sha256(archiveFile) : "missing"}`,
      environmentRef: `local-test; Bun ${Bun.version}; isolated global archive install`,
      actorRef:
        "deterministic blackbox Actors exercising runtime identity; independent quality review is a separate Gate",
      fixtureRef:
        "synthetic GraphSpec v3 with two initial evidence items, one accepted dynamic item, and a bounded repeated Work Attempt",
      startedAt: runStartedAt,
      finishedAt,
      status,
      steps,
      performance: [
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
            commandDurations.length > 0 && Math.max(...commandDurations) < 1_000
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
            archiveBytes > 0 && archiveBytes < 2_000_000 ? "passed" : "failed",
        },
      ],
      diagnostics:
        failure === null
          ? [
              {
                category: "artifact-boundary",
                status: "passed",
                summary:
                  "全部用户动作只经过精确归档安装后的公开 burn-graph 进程边界。",
              },
              {
                category: "goal-integrity",
                status: "passed",
                summary:
                  "执行、动态修订、修复与 Review 历史由同一 Goal snapshot 和事件流复核。",
              },
              {
                category: "privacy",
                status: "passed",
                summary:
                  "仅使用合成数据；全部 envelope 通过单行、大小与绝对路径检查。",
              },
            ]
          : [
              {
                category: "first-divergence",
                status: "failed",
                summary: failure.summary,
              },
            ],
      failure,
    };
    const manifestFile = path.join(testRoot, "up15-evidence-input.json");
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    mkdirSync(outputDirectory, { recursive: true });
    const generated = spawn(
      "bun",
      [evidenceGenerator, "--input", manifestFile, "--output", outputDirectory],
      { cwd: repositoryRoot },
    );
    if (generated.exitCode !== 0) {
      failure ??= {
        stepId: "evidence",
        summary: publicMessage(generated.stderr, privateRoots),
        recovery: "修复 Evidence 输入或生成器后重跑完整 UP15。",
      };
    }
    const resolvedRoot = path.resolve(testRoot);
    assert(
      resolvedRoot.startsWith(path.join(tmpdir(), "burn-graph-up15-")),
      "refusing to remove an unexpected test directory",
    );
    rmSync(resolvedRoot, { recursive: true, force: true });
  }
}

if (fault !== null) {
  // The known-bad verdict was emitted by the self-test branch.
} else if (failure !== null) {
  process.stderr.write(
    `${JSON.stringify({
      schemaVersion: 1,
      ok: false,
      command: "verify.up15",
      error: { code: "UP15_FAILED", message: failure.summary, retryable: true },
    })}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      ok: true,
      command: "verify.up15",
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
