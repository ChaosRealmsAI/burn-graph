import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BurnGraphError } from "@burn-graph/core";

import {
  MAX_PNG_HEIGHT,
  MAX_PNG_WIDTH,
  type BrowserRenderRequest,
  type BrowserRenderResult,
  type RenderBrowser,
  type RenderCapability,
} from "./contracts.ts";

interface CdpResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
  };
}

interface PageTarget {
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

function executable(pathname: string): boolean {
  try {
    accessSync(pathname, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function knownBrowserCandidates(): readonly RenderBrowser[] {
  const candidates: RenderBrowser[] = [];
  if (process.platform === "darwin") {
    candidates.push(
      {
        name: "Google Chrome",
        executable:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      {
        name: "Google Chrome Canary",
        executable:
          "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      },
      {
        name: "Chromium",
        executable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      },
      {
        name: "Microsoft Edge",
        executable:
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      },
    );
  }
  const commandNames =
    process.platform === "win32"
      ? ["chrome.exe", "msedge.exe"]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const command of commandNames) {
    const resolved = Bun.which(command);
    if (resolved) {
      candidates.push({
        name: command.includes("edge")
          ? "Microsoft Edge"
          : command.includes("chromium")
            ? "Chromium"
            : "Google Chrome",
        executable: resolved,
      });
    }
  }
  return candidates;
}

export function discoverRenderBrowser(
  explicit = process.env.BURN_GRAPH_CHROME_BIN,
): RenderBrowser | null {
  if (explicit !== undefined) {
    const resolved = path.resolve(explicit);
    return executable(resolved)
      ? { name: path.basename(resolved), executable: resolved }
      : null;
  }
  return knownBrowserCandidates().find((candidate) =>
    executable(candidate.executable),
  ) ?? null;
}

export function resolveRenderAssetsDirectory(explicit?: string): string {
  const configured = explicit ?? process.env.BURN_GRAPH_VIEWER_DIR;
  if (configured !== undefined) {
    const resolved = path.resolve(configured);
    if (existsSync(path.join(resolved, "render.html"))) return resolved;
    throw new BurnGraphError(
      "RENDER_ASSETS_MISSING",
      "Configured renderer assets are missing",
      false,
      { recovery: "Rebuild or reinstall burn-graph." },
    );
  }
  const candidates = [
    path.resolve(import.meta.dir, "../../../dist/viewer"),
    path.resolve(import.meta.dir, "viewer"),
    path.resolve(process.cwd(), "dist/viewer"),
  ];
  const found = candidates.find((candidate) =>
    existsSync(path.join(candidate, "render.html")),
  );
  if (!found) {
    throw new BurnGraphError(
      "RENDER_ASSETS_MISSING",
      "Packaged renderer assets are missing",
      false,
      { recovery: "Rebuild or reinstall burn-graph." },
    );
  }
  return path.resolve(found);
}

export function inspectRenderCapability(options: {
  readonly assetsDirectory?: string;
  readonly chromeExecutable?: string;
} = {}): RenderCapability {
  try {
    resolveRenderAssetsDirectory(options.assetsDirectory);
  } catch (error) {
    const normalized =
      error instanceof BurnGraphError
        ? error
        : new BurnGraphError("RENDER_ASSETS_MISSING", "Renderer assets are missing");
    return {
      available: false,
      formats: ["svg", "png"],
      browser: null,
      reason: { code: normalized.code, message: normalized.message },
      recovery: "Rebuild or reinstall burn-graph.",
    };
  }
  const explicit =
    options.chromeExecutable ?? process.env.BURN_GRAPH_CHROME_BIN;
  const browser = discoverRenderBrowser(explicit);
  if (!browser) {
    return {
      available: false,
      formats: ["svg", "png"],
      browser: null,
      reason: {
        code: "RENDERER_UNAVAILABLE",
        message: "No supported Chrome-family executable is available",
      },
      recovery:
        "Install Chrome/Chromium or set BURN_GRAPH_CHROME_BIN to its executable.",
    };
  }
  return {
    available: true,
    formats: ["svg", "png"],
    browser: { name: browser.name },
    reason: null,
    recovery: null,
  };
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function rendererServer(assetsDirectory: string): {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;
} {
  const resolvedRoot = path.resolve(assetsDirectory);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 10,
    fetch(request) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      const url = new URL(request.url);
      const requested =
        url.pathname === "/" ? "render.html" : url.pathname.slice(1);
      const normalized = path
        .normalize(requested)
        .replace(/^(\.\.(\/|\\|$))+/, "");
      const target = path.resolve(resolvedRoot, normalized);
      if (
        !target.startsWith(`${resolvedRoot}${path.sep}`) ||
        !existsSync(target)
      ) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(Bun.file(target), {
        headers: {
          "content-type": contentType(target),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          "referrer-policy": "no-referrer",
        },
      });
    },
  });
  return {
    server,
    url: `http://127.0.0.1:${server.port}/render.html`,
  };
}

function timeoutError(): BurnGraphError {
  return new BurnGraphError(
    "RENDER_TIMEOUT",
    "Headless rendering exceeded the 20 second limit",
    true,
  );
}

async function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError()), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function devToolsEndpoint(
  child: Bun.Subprocess<"ignore", "ignore", "pipe">,
  deadline: number,
): Promise<string> {
  const reader = child.stderr.getReader();
  let captured = "";
  for (;;) {
    const chunk = await beforeDeadline(reader.read(), deadline);
    if (chunk.done) break;
    captured = `${captured}${new TextDecoder().decode(chunk.value)}`.slice(
      -65_536,
    );
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(captured);
    if (match?.[1]) return match[1];
  }
  throw new BurnGraphError(
    "RENDER_FAILED",
    "Headless browser exited before DevTools became ready",
    true,
  );
}

async function pageEndpoint(
  browserEndpoint: string,
  rendererUrl: string,
  deadline: number,
): Promise<string> {
  const endpoint = new URL(browserEndpoint);
  const targetUrl = `http://${endpoint.host}/json/list`;
  for (;;) {
    const response = await beforeDeadline(fetch(targetUrl), deadline);
    if (response.ok) {
      const targets = (await response.json()) as PageTarget[];
      const page = targets.find(
        (candidate) =>
          candidate.type === "page" &&
          candidate.url?.startsWith(rendererUrl) &&
          typeof candidate.webSocketDebuggerUrl === "string",
      );
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    }
    await beforeDeadline(Bun.sleep(25), deadline);
  }
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (reason: unknown) => void;
    }
  >();

  private constructor(
    private readonly socket: WebSocket,
    private readonly deadline: number,
  ) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as CdpResponse;
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new BurnGraphError(
            "RENDER_FAILED",
            message.error.message ?? "Chrome DevTools command failed",
            true,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(
          new BurnGraphError(
            "RENDER_FAILED",
            "Headless browser connection closed unexpectedly",
            true,
          ),
        );
      }
      this.pending.clear();
    });
  }

  static async connect(endpoint: string, deadline: number): Promise<CdpClient> {
    const socket = new WebSocket(endpoint);
    await beforeDeadline(
      new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener(
          "error",
          () =>
            reject(
              new BurnGraphError(
                "RENDER_FAILED",
                "Unable to connect to the headless browser",
                true,
              ),
            ),
          { once: true },
        );
      }),
      deadline,
    );
    return new CdpClient(socket, deadline);
  }

  async send<T>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<T> {
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    try {
      return (await beforeDeadline(response, this.deadline)) as T;
    } finally {
      this.pending.delete(id);
    }
  }

  close(): void {
    this.socket.close();
  }
}

async function evaluate<T>(
  client: CdpClient,
  expression: string,
): Promise<T> {
  const response = await client.send<{
    readonly result?: {
      readonly value?: T;
      readonly description?: string;
    };
    readonly exceptionDetails?: {
      readonly text?: string;
      readonly exception?: { readonly description?: string };
    };
  }>("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new BurnGraphError(
      "RENDER_FAILED",
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Browser renderer failed",
      true,
    );
  }
  if (response.result?.value === undefined) {
    throw new BurnGraphError(
      "RENDER_FAILED",
      response.result?.description ?? "Browser renderer returned no value",
      true,
    );
  }
  return response.result.value;
}

async function waitForRenderer(
  client: CdpClient,
  deadline: number,
): Promise<void> {
  for (;;) {
    const ready = await evaluate<boolean>(
      client,
      "document.readyState === 'complete' && typeof window.__burnGraphRenderer?.render === 'function'",
    );
    if (ready) return;
    await beforeDeadline(Bun.sleep(25), deadline);
  }
}

async function stopExactChild(
  child: Bun.Subprocess<"ignore", "ignore", "pipe">,
): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(1_000).then(() => false),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

export async function renderInIsolatedBrowser(
  request: BrowserRenderRequest,
): Promise<BrowserRenderResult> {
  if ((request.source === null) === (request.svg === null)) {
    throw new BurnGraphError(
      "RENDER_FAILED",
      "Browser render request requires exactly one source representation",
    );
  }
  let profile: string | null = null;
  let renderServer: ReturnType<typeof rendererServer> | null = null;
  let child: Bun.Subprocess<"ignore", "ignore", "pipe"> | null = null;
  let client: CdpClient | null = null;
  try {
    profile = mkdtempSync(
      path.join(tmpdir(), "burn-graph-render-profile-"),
    );
    renderServer = rendererServer(request.assetsDirectory);
    const rendererUrl = `${renderServer.url}?instance=${crypto.randomUUID()}`;
    const deadline = Date.now() + request.timeoutMs;
    try {
      child = Bun.spawn(
        [
          request.browser.executable,
          "--headless=new",
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-default-apps",
          "--disable-extensions",
          "--disable-features=MediaRouter,OptimizationHints,Translate",
          "--disable-sync",
          "--metrics-recording-only",
          "--no-default-browser-check",
          "--no-first-run",
          "--password-store=basic",
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=0",
          `--user-data-dir=${profile}`,
          "--window-size=800,600",
          rendererUrl,
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          env: {
            PATH: process.env.PATH ?? "",
          },
        },
      );
    } catch {
      throw new BurnGraphError(
        "RENDERER_UNAVAILABLE",
        "The configured Chrome-family executable could not be launched",
        true,
      );
    }
    const browserEndpoint = await devToolsEndpoint(child, deadline);
    const page = await pageEndpoint(browserEndpoint, rendererUrl, deadline);
    client = await CdpClient.connect(page, deadline);
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await waitForRenderer(client, deadline);

    const browserVersion = await client.send<{
      readonly product?: string;
    }>("Browser.getVersion");
    let rendered: {
      readonly svg: string;
      readonly width: number;
      readonly height: number;
    };
    if (request.source !== null) {
      rendered = await evaluate(
        client,
        `window.__burnGraphRenderer.render(${JSON.stringify(request.renderId)}, ${JSON.stringify(request.source)})`,
      );
    } else {
      const providedSvg = request.svg;
      if (providedSvg === null) {
        throw new BurnGraphError(
          "RENDER_FAILED",
          "Browser render request is missing SVG input",
        );
      }
      const dimensions = await evaluate<{
        readonly width: number;
        readonly height: number;
      }>(
        client,
        `window.__burnGraphRenderer.load(${JSON.stringify(providedSvg)})`,
      );
      rendered = {
        svg: providedSvg,
        width: dimensions.width,
        height: dimensions.height,
      };
    }

    let png: Uint8Array | null = null;
    let pngWidth: number | null = null;
    let pngHeight: number | null = null;
    if (request.capturePng) {
      const layout = await evaluate<{
        readonly width: number;
        readonly height: number;
      }>(
        client,
        `window.__burnGraphRenderer.preparePng(${MAX_PNG_WIDTH}, ${MAX_PNG_HEIGHT})`,
      );
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: layout.width,
        height: layout.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(
        client,
        `window.__burnGraphRenderer.preparePng(${MAX_PNG_WIDTH}, ${MAX_PNG_HEIGHT})`,
      );
      const captured = await client.send<{ readonly data?: string }>(
        "Page.captureScreenshot",
        {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
          clip: {
            x: 0,
            y: 0,
            width: layout.width,
            height: layout.height,
            scale: 1,
          },
        },
      );
      if (!captured.data) {
        throw new BurnGraphError(
          "INVALID_RENDER_OUTPUT",
          "Headless browser returned no PNG data",
        );
      }
      png = Buffer.from(captured.data, "base64");
      pngWidth = layout.width;
      pngHeight = layout.height;
    }

    return {
      ...rendered,
      png,
      pngWidth,
      pngHeight,
      browser: {
        name: request.browser.name,
        version: browserVersion.product ?? "unknown",
      },
    };
  } catch (error) {
    if (error instanceof BurnGraphError) throw error;
    throw new BurnGraphError(
      "RENDER_FAILED",
      error instanceof Error ? error.message : "Headless rendering failed",
      true,
    );
  } finally {
    client?.close();
    try {
      if (child) await stopExactChild(child);
    } finally {
      try {
        renderServer?.server.stop(true);
      } finally {
        if (profile !== null) {
          rmSync(profile, { recursive: true, force: true });
        }
      }
    }
  }
}
