// Purpose: Generate privacy-safe JSON and HTML Evidence from one real User Path run.
// Usage: bun scripts/verify/e2e-evidence.ts --input <manifest.json> --output <evidence-dir>
// Notes: Screenshot source paths are consumed locally and never serialized into Evidence.

import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

type RunStatus = "passed" | "failed" | "blocked";

interface ScreenshotInput {
  readonly source: string;
  readonly name: string;
  readonly review: "passed-manual-visual-review";
}

interface StepInput {
  readonly id: string;
  readonly pathStep: string;
  readonly action: string;
  readonly expected: string;
  readonly observed: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: RunStatus;
  readonly screenshot?: ScreenshotInput;
}

interface PerformanceInput {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
  readonly budget: string;
  readonly status: RunStatus;
}

interface DiagnosticInput {
  readonly category: string;
  readonly status: RunStatus;
  readonly summary: string;
}

interface EvidenceInput {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly userPathId: string;
  readonly version: string;
  readonly artifactRef: string;
  readonly environmentRef: string;
  readonly actorRef: string;
  readonly fixtureRef: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: RunStatus;
  readonly steps: readonly StepInput[];
  readonly performance: readonly PerformanceInput[];
  readonly diagnostics: readonly DiagnosticInput[];
  readonly failure: null | {
    readonly stepId: string;
    readonly summary: string;
    readonly recovery: string;
  };
}

interface EvidenceArtifact {
  readonly id: string;
  readonly kind: "screenshot";
  readonly path: string;
  readonly mimeType: "image/jpeg" | "image/png";
  readonly bytes: number;
  readonly sha256: string;
  readonly redaction: "not-required-synthetic-fixture";
  readonly secretScan: "passed-bounded-bytes-and-manual-visual-review";
}

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const PRIVATE_TEXT_PATTERNS = [
  { label: "absolute macOS Home path", pattern: /\/Users\//u },
  { label: "absolute Linux Home path", pattern: /\/home\//u },
  { label: "macOS temporary path", pattern: /\/var\/folders\//u },
  { label: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/u },
  {
    label: "private key",
    pattern: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/u,
  },
  {
    label: "Bearer credential",
    pattern: /Bearer [A-Za-z0-9._-]{20,}/u,
  },
] as const;

function argument(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing ${name}.`);
  }
  return path.resolve(value);
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  assertString(value, field);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
}

function assertStatus(value: unknown, field: string): asserts value is RunStatus {
  if (!["passed", "failed", "blocked"].includes(String(value))) {
    throw new Error(`${field} must be passed, failed, or blocked.`);
  }
}

function validateInput(value: unknown): asserts value is EvidenceInput {
  if (typeof value !== "object" || value === null) {
    throw new Error("Evidence input must be an object.");
  }
  const input = value as Partial<EvidenceInput>;
  if (input.schemaVersion !== 1) {
    throw new Error("schemaVersion must be 1.");
  }
  for (const field of [
    "runId",
    "userPathId",
    "version",
    "artifactRef",
    "environmentRef",
    "actorRef",
    "fixtureRef",
  ] as const) {
    assertString(input[field], field);
  }
  assertTimestamp(input.startedAt, "startedAt");
  assertTimestamp(input.finishedAt, "finishedAt");
  assertStatus(input.status, "status");
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new Error("steps must contain the complete User Path.");
  }
  for (const [index, step] of input.steps.entries()) {
    if (typeof step !== "object" || step === null) {
      throw new Error(`steps[${index}] must be an object.`);
    }
    for (const field of [
      "id",
      "pathStep",
      "action",
      "expected",
      "observed",
    ] as const) {
      assertString(step[field], `steps[${index}].${field}`);
    }
    assertTimestamp(step.startedAt, `steps[${index}].startedAt`);
    assertTimestamp(step.finishedAt, `steps[${index}].finishedAt`);
    assertStatus(step.status, `steps[${index}].status`);
    if (step.screenshot !== undefined) {
      assertString(step.screenshot.source, `steps[${index}].screenshot.source`);
      assertString(step.screenshot.name, `steps[${index}].screenshot.name`);
      if (step.screenshot.review !== "passed-manual-visual-review") {
        throw new Error(
          `steps[${index}].screenshot.review must record a real visual review.`,
        );
      }
      if (!/^[a-z0-9][a-z0-9-]*\.(?:jpg|png)$/u.test(step.screenshot.name)) {
        throw new Error(
          `steps[${index}].screenshot.name must be a stable lowercase JPG or PNG name.`,
        );
      }
    }
  }
  if (!Array.isArray(input.performance)) {
    throw new Error("performance must be an array.");
  }
  for (const [index, sample] of input.performance.entries()) {
    assertString(sample.name, `performance[${index}].name`);
    if (!Number.isFinite(sample.value)) {
      throw new Error(`performance[${index}].value must be finite.`);
    }
    assertString(sample.unit, `performance[${index}].unit`);
    assertString(sample.budget, `performance[${index}].budget`);
    assertStatus(sample.status, `performance[${index}].status`);
  }
  if (!Array.isArray(input.diagnostics)) {
    throw new Error("diagnostics must be an array.");
  }
  for (const [index, diagnostic] of input.diagnostics.entries()) {
    assertString(diagnostic.category, `diagnostics[${index}].category`);
    assertStatus(diagnostic.status, `diagnostics[${index}].status`);
    assertString(diagnostic.summary, `diagnostics[${index}].summary`);
  }
  if (
    input.status === "passed" &&
    (input.failure !== null ||
      input.steps.some((step) => step.status !== "passed") ||
      input.performance.some((sample) => sample.status !== "passed") ||
      input.diagnostics.some(
        (diagnostic) => diagnostic.status !== "passed",
      ))
  ) {
    throw new Error("A passed report cannot contain a non-passing result.");
  }
  if (input.status !== "passed" && input.failure === null) {
    throw new Error("A failed or blocked report must describe the failure.");
  }
  if (Date.parse(input.startedAt) > Date.parse(input.finishedAt)) {
    throw new Error("finishedAt must not precede startedAt.");
  }
  let previous = Date.parse(input.startedAt);
  for (const [index, step] of input.steps.entries()) {
    const started = Date.parse(step.startedAt);
    const finished = Date.parse(step.finishedAt);
    if (started < previous || finished < started) {
      throw new Error(`steps[${index}] timestamps are out of order.`);
    }
    previous = finished;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function screenshotMimeType(
  bytes: Buffer,
  name: string,
): "image/jpeg" | "image/png" {
  const png = bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE);
  const jpeg = bytes
    .subarray(0, JPEG_SIGNATURE.byteLength)
    .equals(JPEG_SIGNATURE);
  if ((png && name.endsWith(".png")) || (jpeg && name.endsWith(".jpg"))) {
    return png ? "image/png" : "image/jpeg";
  }
  throw new Error(
    `Screenshot ${name} bytes do not match its declared extension.`,
  );
}

function assertPrivacySafeText(value: string, subject: string): void {
  for (const candidate of PRIVATE_TEXT_PATTERNS) {
    if (candidate.pattern.test(value)) {
      throw new Error(`${subject} contains ${candidate.label}.`);
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function durationMilliseconds(startedAt: string, finishedAt: string): number {
  return Date.parse(finishedAt) - Date.parse(startedAt);
}

function renderHtml(
  input: EvidenceInput,
  steps: readonly (Omit<StepInput, "screenshot"> & {
    readonly screenshotReferences: readonly string[];
  })[],
): string {
  const resultLabel = {
    passed: "通过",
    failed: "失败",
    blocked: "阻塞",
  }[input.status];
  const stepSections = steps
    .map((step) => {
      const screenshot = step.screenshotReferences[0];
      return `
        <article class="step">
          <div class="step-heading">
            <span>${escapeHtml(step.id)}</span>
            <strong>${escapeHtml(step.pathStep)}</strong>
            <mark data-status="${step.status}">${step.status}</mark>
          </div>
          <dl>
            <dt>用户动作</dt><dd>${escapeHtml(step.action)}</dd>
            <dt>可见预期</dt><dd>${escapeHtml(step.expected)}</dd>
            <dt>可见结果</dt><dd>${escapeHtml(step.observed)}</dd>
            <dt>时间</dt><dd>${escapeHtml(step.startedAt)} → ${escapeHtml(step.finishedAt)}</dd>
          </dl>
          ${
            screenshot === undefined
              ? ""
              : `<figure><img src="${escapeHtml(screenshot)}" alt="${escapeHtml(step.pathStep)}"><figcaption>${escapeHtml(step.observed)}</figcaption></figure>`
          }
        </article>`;
    })
    .join("\n");
  const performanceRows = input.performance
    .map(
      (sample) => `
        <tr>
          <td>${escapeHtml(sample.name)}</td>
          <td>${sample.value} ${escapeHtml(sample.unit)}</td>
          <td>${escapeHtml(sample.budget)}</td>
          <td>${escapeHtml(sample.status)}</td>
        </tr>`,
    )
    .join("\n");
  const diagnostics = input.diagnostics
    .map(
      (diagnostic) => `
        <li><strong>${escapeHtml(diagnostic.category)}</strong> · ${escapeHtml(diagnostic.status)} — ${escapeHtml(diagnostic.summary)}</li>`,
    )
    .join("\n");
  const failure =
    input.failure === null
      ? ""
      : `<section class="failure"><h2>首次偏离</h2><p>${escapeHtml(input.failure.stepId)} · ${escapeHtml(input.failure.summary)}</p><p>恢复：${escapeHtml(input.failure.recovery)}</p></section>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.userPathId)} ${escapeHtml(input.version)} E2E Evidence</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #080b12; color: #f4f7fb; }
    body { margin: 0 auto; max-width: 1480px; padding: 48px 32px 96px; }
    header, section, article, details { border: 1px solid #293042; background: #101521; border-radius: 18px; }
    header, section, details { padding: 28px; margin-bottom: 24px; }
    h1 { margin: 8px 0 18px; font-size: clamp(32px, 5vw, 64px); }
    h2 { margin-top: 0; }
    .eyebrow, dt, .step-heading span { color: #8793aa; font: 600 12px/1.4 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; padding: 0; list-style: none; }
    .summary li { padding: 16px; background: #0b0f18; border-radius: 12px; }
    .result { color: #67d99c; }
    .step { padding: 24px; margin-bottom: 20px; }
    .step-heading { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 16px; }
    .step-heading strong { font-size: 22px; }
    mark { border: 1px solid #4e5d7b; border-radius: 999px; padding: 5px 10px; background: transparent; color: #b8c3d8; }
    mark[data-status="passed"] { border-color: #4cae7c; color: #67d99c; }
    dl { display: grid; grid-template-columns: 120px 1fr; gap: 10px 20px; margin: 24px 0; }
    dd { margin: 0; color: #c9d2e2; }
    figure { margin: 24px 0 0; }
    img { display: block; width: 100%; height: auto; border: 1px solid #30394d; border-radius: 14px; background: #070a10; }
    figcaption { color: #8793aa; margin-top: 10px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #293042; }
    .failure { border-color: #ff6379; }
    summary { cursor: pointer; font-weight: 700; }
    @media (max-width: 700px) { body { padding: 24px 14px 60px; } dl { grid-template-columns: 1fr; } .step-heading { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">真实 User Path E2E Evidence</div>
    <h1>${escapeHtml(input.userPathId)} · <span class="result">${resultLabel}</span></h1>
    <ul class="summary">
      <li><span class="eyebrow">版本</span><br>${escapeHtml(input.version)}</li>
      <li><span class="eyebrow">Artifact</span><br>${escapeHtml(input.artifactRef)}</li>
      <li><span class="eyebrow">环境</span><br>${escapeHtml(input.environmentRef)}</li>
      <li><span class="eyebrow">耗时</span><br>${durationMilliseconds(input.startedAt, input.finishedAt)} ms</li>
    </ul>
  </header>
  ${failure}
  <section>
    <h2>完整用户路径</h2>
    ${stepSections}
  </section>
  <section>
    <h2>性能与容量</h2>
    <table><thead><tr><th>指标</th><th>结果</th><th>预算</th><th>状态</th></tr></thead><tbody>${performanceRows}</tbody></table>
  </section>
  <details>
    <summary>有界运行时诊断</summary>
    <ul>${diagnostics}</ul>
  </details>
</body>
</html>
`;
}

const inputPath = argument("--input");
const outputDirectory = argument("--output");
const rawInput: unknown = JSON.parse(await readFile(inputPath, "utf8"));
validateInput(rawInput);

await mkdir(path.join(outputDirectory, "screenshots"), { recursive: true });

const artifacts: EvidenceArtifact[] = [];
const steps = [];
for (const step of rawInput.steps) {
  const screenshotReferences: string[] = [];
  if (step.screenshot !== undefined) {
    const bytes = await readFile(step.screenshot.source);
    if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new Error(
        `Screenshot ${step.screenshot.name} exceeds the bounded artifact size.`,
      );
    }
    const mimeType = screenshotMimeType(bytes, step.screenshot.name);
    assertPrivacySafeText(
      bytes.toString("latin1"),
      `Screenshot ${step.screenshot.name}`,
    );
    const relativePath = `screenshots/${step.screenshot.name}`;
    const destination = path.join(outputDirectory, relativePath);
    if (path.resolve(step.screenshot.source) !== path.resolve(destination)) {
      await copyFile(step.screenshot.source, destination);
    }
    const copied = await stat(destination);
    if (copied.size !== bytes.byteLength) {
      throw new Error(`Screenshot ${step.screenshot.name} copy is incomplete.`);
    }
    screenshotReferences.push(relativePath);
    artifacts.push({
      id: `screenshot-${step.id}`,
      kind: "screenshot",
      path: relativePath,
      mimeType,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      redaction: "not-required-synthetic-fixture",
      secretScan: "passed-bounded-bytes-and-manual-visual-review",
    });
  }
  const { screenshot: _screenshot, ...publicStep } = step;
  steps.push({ ...publicStep, screenshotReferences });
}

const result = {
  schemaVersion: rawInput.schemaVersion,
  runId: rawInput.runId,
  userPathId: rawInput.userPathId,
  version: rawInput.version,
  artifactRef: rawInput.artifactRef,
  environmentRef: rawInput.environmentRef,
  actorRef: rawInput.actorRef,
  fixtureRef: rawInput.fixtureRef,
  startedAt: rawInput.startedAt,
  finishedAt: rawInput.finishedAt,
  status: rawInput.status,
  steps,
  performance: rawInput.performance,
  artifacts,
  diagnostics: rawInput.diagnostics,
  failure: rawInput.failure,
};
const reportHtml = renderHtml(rawInput, steps).replace(/[ \t]+$/gm, "");
assertPrivacySafeText(JSON.stringify(result), "result.json");
assertPrivacySafeText(reportHtml, "report.html");

await writeFile(
  path.join(outputDirectory, "result.json"),
  `${JSON.stringify(result, null, 2)}\n`,
  { mode: 0o600 },
);
await writeFile(
  path.join(outputDirectory, "report.html"),
  reportHtml,
  { mode: 0o600 },
);

process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    ok: true,
    result: path.join(outputDirectory, "result.json"),
    report: path.join(outputDirectory, "report.html"),
    artifacts,
  })}\n`,
);
