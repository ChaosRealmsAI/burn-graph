// The `inspect` command group: bounded read-only projections of runtime and
// graph state.
//
// Registered from index.ts rather than defined there, so the largest command
// group in the CLI no longer shares a file with the seven others. Every command
// here is a read; nothing in this file mutates a Run.

import {
  BurnGraphError,
  BurnGraphService,
  discoverProjectRoot,
  type GraphStatus,
  type NodeStatus,
  type RunPriority,
} from "@burn-graph/core";
import { type RenderScope } from "@burn-graph/render";
import { Option } from "commander";

import {
  boundedInteger,
  boundedNonNegativeInteger,
  globalOptions,
  GRAPH_STATUSES,
  group,
  nonNegativeInteger,
  parseNodeStatuses,
  success,
  withService,
} from "./support.ts";

export function registerInspect(): void {
  const inspect = group("inspect", "read bounded runtime and graph projections");

  inspect
    .command("overview")
    .description("show filtered multi-Graph progress and actionable nodes")
    .option("--graph <run-or-graph>", "filter one Run")
    .option("--root-run <run-or-graph>", "filter one complete root Run tree")
    .option(
      "--depth <count>",
      "filter exact hierarchy depth",
      boundedNonNegativeInteger(8),
    )
    .addOption(
      new Option("--run-status <status>", "filter Run status").choices([
        ...GRAPH_STATUSES,
      ]),
    )
    .option("--node-status <statuses>", "comma-separated Node statuses")
    .option("--actor <id>", "filter Node owner")
    .option("--tag <tag>", "filter GraphSpec Node tag")
    .option("--resource <name>", "filter declared or owned exclusive resource")
    .addOption(
      new Option(
        "--priority <priority>",
        "filter configured root priority",
      ).choices(["low", "normal", "high"]),
    )
    .option("--limit <count>", "maximum node rows", boundedInteger(1_000), 50)
    .action(
      (options: {
        graph?: string;
        rootRun?: string;
        depth?: number;
        runStatus?: GraphStatus;
        nodeStatus?: string;
        actor?: string;
        tag?: string;
        resource?: string;
        priority?: RunPriority;
        limit: number;
      }) => {
        const defaultStatuses: readonly NodeStatus[] = [
          "ready",
          "running",
          "blocked",
          "failed",
        ];
        const data = withService((service) =>
          service.inspectOverview({
            ...(options.graph ? { run: options.graph } : {}),
            ...(options.rootRun ? { root: options.rootRun } : {}),
            ...(options.depth !== undefined ? { depth: options.depth } : {}),
            ...(options.runStatus ? { runStatus: options.runStatus } : {}),
            nodeStatuses: parseNodeStatuses(options.nodeStatus) ?? defaultStatuses,
            ...(options.actor ? { actor: options.actor } : {}),
            ...(options.tag ? { tag: options.tag } : {}),
            ...(options.resource ? { resource: options.resource } : {}),
            ...(options.priority ? { priority: options.priority } : {}),
            limit: options.limit,
          }),
        );
        success("inspect.overview", data);
      },
    );

  inspect
    .command("run")
    .description("show one canonical Run snapshot")
    .argument("<run-or-graph>")
    .option("--events <count>", "recent event count", boundedInteger(1_000), 100)
    .action((reference: string, options: { events: number }) => {
      success(
        "inspect.run",
        withService((service) => service.getSnapshot(reference, options.events)),
      );
    });

  inspect
    .command("tree")
    .description("show one bounded folded or expanded Run tree snapshot")
    .argument("<run-or-graph>")
    .option(
      "--depth <count>",
      "expanded child Run depth",
      boundedNonNegativeInteger(8),
      0,
    )
    .option(
      "--limit <count>",
      "maximum rendered nodes",
      boundedInteger(500),
      500,
    )
    .option("--events <count>", "root event count", boundedInteger(1_000), 100)
    .action(
      (
        reference: string,
        options: { depth: number; limit: number; events: number },
      ) => {
        success(
          "inspect.tree",
          withService((service) =>
            service.getTreeSnapshot(
              reference,
              options.depth,
              options.limit,
              options.events,
            ),
          ),
        );
      },
    );

  inspect
    .command("node")
    .description("show one Node, its prompt, Attempts, edges, and events")
    .argument("<run-or-graph>")
    .argument("<node>")
    .option("--events <count>", "recent event count", boundedInteger(1_000), 50)
    .action(
      (reference: string, nodeId: string, options: { events: number }) => {
        success(
          "inspect.node",
          withService((service) =>
            service.inspectNode(reference, nodeId, options.events),
          ),
        );
      },
    );

  inspect
    .command("ready")
    .description("diagnose the Ready queue without claiming work")
    .option("--graph <run-or-graph>", "filter one Run")
    .option("--actor <id>", "rank rows for one Actor")
    .action((options: { graph?: string; actor?: string }) => {
      const rows = withService((service) => [...service.listReady(options.graph)]);
      if (options.actor) {
        rows.sort((left, right) => {
          const rank = (actorHint: string | null): number =>
            actorHint === options.actor ? 0 : actorHint === null ? 1 : 2;
          return rank(left.actorHint) - rank(right.actorHint);
        });
      }
      success("inspect.ready", rows, {
        nextActions: [
          {
            id: "next",
            command: `burn-graph next --actor ${options.actor ?? "primary"}`,
            description: "Let the Runtime claim eligible nodes automatically.",
          },
        ],
      });
    });

  inspect
    .command("waits")
    .description("list bounded durable Signal state without advancing deadlines")
    .argument("[run-or-graph]")
    .option("--limit <count>", "maximum rows", boundedInteger(1_000), 100)
    .action((reference: string | undefined, options: { limit: number }) => {
      success(
        "inspect.waits",
        withService((service) =>
          service.listWaitSignals(reference).slice(0, options.limit),
        ),
      );
    });

  inspect
    .command("resources")
    .description("list current exclusive Assignment and Gate resource ownership")
    .argument("[run-or-graph]")
    .option("--limit <count>", "maximum rows", boundedInteger(1_000), 100)
    .action((reference: string | undefined, options: { limit: number }) => {
      success(
        "inspect.resources",
        withService((service) =>
          service.listResourceLocks(reference).slice(0, options.limit),
        ),
      );
    });

  inspect
    .command("metrics")
    .description("derive bounded portfolio metrics without private text or mutation")
    .argument("[run-or-graph]")
    .action((reference?: string) => {
      success(
        "inspect.metrics",
        withService((service) => service.inspectMetrics(reference)),
      );
    });

  inspect
    .command("executions")
    .description("list bounded Gate execution evidence without raw public events")
    .argument("[run-or-graph]")
    .option("--limit <count>", "maximum rows", boundedInteger(100), 100)
    .option("--include-output", "include bounded local stdout/stderr")
    .option(
      "--output-bytes <count>",
      "combined stdout/stderr bytes retained per row",
      boundedInteger(16_384),
      4_096,
    )
    .action((
      reference: string | undefined,
      options: {
        limit: number;
        includeOutput?: boolean;
        outputBytes: number;
      },
    ) => {
      success(
        "inspect.executions",
        withService((service) =>
          options.includeOutput
            ? service.inspectCheckExecutions(
                reference,
                options.limit,
                options.outputBytes,
              )
            : service.listCheckExecutions(reference).slice(0, options.limit),
        ),
      );
    });

  inspect
    .command("mermaid")
    .description("return one Run or Run tree Mermaid projection inside JSON")
    .argument("<run-or-graph>")
    .addOption(
      new Option("--scope <scope>", "projection scope")
        .choices(["run", "tree"])
        .default("run"),
    )
    .option(
      "--depth <count>",
      "expanded child Run depth for tree scope",
      boundedNonNegativeInteger(8),
      0,
    )
    .option(
      "--limit <count>",
      "maximum rendered tree nodes",
      boundedInteger(500),
      500,
    )
    .action(
      (
        reference: string,
        options: { scope: RenderScope; depth: number; limit: number },
      ) => {
        const projection = withService((service) => {
          if (options.scope === "tree") {
            const tree = service.getTreeSnapshot(
              reference,
              options.depth,
              options.limit,
              0,
            );
            return {
              summary: tree.root.summary,
              source: tree.mermaid,
              projection: tree.projection,
            };
          }
          const snapshot = service.getSnapshot(reference, 0);
          return {
            summary: snapshot.summary,
            source: snapshot.mermaid,
            projection: null,
          };
        });
      success("inspect.mermaid", {
          runId: projection.summary.runId,
          graphId: projection.summary.graphId,
          runtimeRevision: projection.summary.runtimeRevision,
          scope: options.scope,
          projection: projection.projection,
          source: projection.source,
      });
      },
    );

  inspect
    .command("events")
    .description("list or follow durable events")
    .argument("[run-or-graph]")
    .option("--after <sequence>", "exclusive sequence cursor", nonNegativeInteger, 0)
    .option("--limit <count>", "maximum events", boundedInteger(1_000), 100)
    .option("--follow", "stream matching events as JSON Lines")
    .action(
      async (
        reference: string | undefined,
        options: { after: number; limit: number; follow?: boolean },
      ) => {
        if (!options.follow) {
          success(
            "inspect.events",
            withService((service) =>
              service.listEvents(reference, options.after, options.limit),
            ),
          );
          return;
        }
        let cursor = options.after;
        const root = discoverProjectRoot(
          globalOptions().root ?? process.cwd(),
        );
        for (;;) {
          const service = new BurnGraphService(root);
          try {
            const batch = service.listEvents(reference, cursor, options.limit);
            for (const event of batch) {
              process.stdout.write(
                `${JSON.stringify({
                  schemaVersion: 1,
                  ok: true,
                  command: "inspect.events",
                  data: event,
                })}\n`,
              );
              cursor = event.sequence;
            }
          } finally {
            service.close();
          }
          await Bun.sleep(500);
        }
      },
    );

}
