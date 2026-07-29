import { existsSync } from "node:fs";
import path from "node:path";

import { BurnGraphError, BurnGraphService } from "@burn-graph/core";

export interface ViewerServerOptions {
  readonly projectRoot: string;
  readonly host: string;
  readonly port: number;
  readonly open: boolean;
  readonly viewerDirectory?: string;
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function resolveViewerDirectory(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.BURN_GRAPH_VIEWER_DIR,
    path.resolve(import.meta.dir, "../../../dist/viewer"),
    path.resolve(import.meta.dir, "viewer"),
    path.resolve(process.cwd(), "dist/viewer"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) =>
    existsSync(path.join(candidate, "index.html")),
  );
  if (!found) {
    throw new BurnGraphError(
      "VIEWER_NOT_BUILT",
      "Viewer assets are missing; run `bun run build:viewer` first",
      false,
      { candidates },
    );
  }
  return path.resolve(found);
}

function apiError(error: unknown): Response {
  const normalized =
    error instanceof BurnGraphError
      ? error
      : new BurnGraphError(
          "INTERNAL_ERROR",
          error instanceof Error ? error.message : String(error),
        );
  return jsonResponse(
    {
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
      },
    },
    normalized.code.endsWith("NOT_FOUND") ? 404 : 400,
  );
}

export async function startViewerServer(
  options: ViewerServerOptions,
): Promise<never> {
  const service = new BurnGraphService(options.projectRoot);
  const viewerDirectory = resolveViewerDirectory(options.viewerDirectory);
  const indexFile = path.join(viewerDirectory, "index.html");

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonResponse(
          {
            ok: false,
            error: {
              code: "READ_ONLY_VIEWER",
              message: "Viewer HTTP routes are read-only",
              retryable: false,
            },
          },
          405,
        );
      }
      try {
        if (url.pathname === "/api/health") {
          return jsonResponse({
            ok: true,
            projectId: service.config.projectId,
            capturedAt: new Date().toISOString(),
          });
        }
        if (url.pathname === "/api/snapshot") {
          return jsonResponse({ ok: true, data: service.projectSnapshot() });
        }
        if (url.pathname.startsWith("/api/trees/")) {
          const reference = decodeURIComponent(
            url.pathname.slice("/api/trees/".length),
          );
          const depth = Number(url.searchParams.get("depth") ?? "0");
          const limit = Number(url.searchParams.get("limit") ?? "500");
          return jsonResponse({
            ok: true,
            data: service.getTreeSnapshot(reference, depth, limit, 100),
          });
        }
        if (url.pathname.startsWith("/api/graphs/")) {
          const reference = decodeURIComponent(
            url.pathname.slice("/api/graphs/".length),
          );
          return jsonResponse({
            ok: true,
            data: service.getSnapshot(reference, 100),
          });
        }
        if (url.pathname === "/api/events") {
          let cursor = Number(url.searchParams.get("after") ?? "0");
          if (!Number.isInteger(cursor) || cursor < 0) cursor = 0;
          const encoder = new TextEncoder();
          let timer: ReturnType<typeof setInterval> | undefined;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const send = () => {
                try {
                  const events = service.listEvents(undefined, cursor, 100);
                  for (const event of events) {
                    controller.enqueue(
                      encoder.encode(
                        `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`,
                      ),
                    );
                    cursor = event.sequence;
                  }
                  controller.enqueue(encoder.encode(`: cursor ${cursor}\n\n`));
                } catch (error) {
                  controller.error(error);
                  if (timer) clearInterval(timer);
                }
              };
              send();
              timer = setInterval(send, 500);
            },
            cancel() {
              if (timer) clearInterval(timer);
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache, no-store",
              connection: "keep-alive",
              "x-accel-buffering": "no",
            },
          });
        }
        if (url.pathname.startsWith("/api/")) {
          return jsonResponse(
            {
              ok: false,
              error: {
                code: "NOT_FOUND",
                message: "Unknown Viewer API route",
                retryable: false,
              },
            },
            404,
          );
        }

        const requested =
          url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const normalized = path.normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
        const candidate = path.resolve(viewerDirectory, normalized);
        const file =
          candidate.startsWith(`${viewerDirectory}${path.sep}`) &&
          existsSync(candidate)
            ? candidate
            : indexFile;
        return new Response(Bun.file(file), {
          headers: {
            "content-type": contentType(file),
            "x-content-type-options": "nosniff",
            "content-security-policy":
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            "referrer-policy": "no-referrer",
          },
        });
      } catch (error) {
        return apiError(error);
      }
    },
  });

  const url = `http://${options.host}:${server.port}`;
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      ok: true,
      command: "__viewer-serve",
      data: {
        url,
        projectId: service.config.projectId,
        pid: process.pid,
        readOnly: true,
      },
    })}\n`,
  );

  if (options.open) {
    Bun.spawn(["/usr/bin/open", "-n", "-a", "Google Chrome", url], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  const close = () => {
    server.stop(true);
    service.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  return await new Promise<never>(() => undefined);
}
