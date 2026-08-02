// Graph and Check authoring: validation, revision-guarded persistence, listing
// and cloning of the documents a Run is later started from.
//
// This is a collaborator rather than more methods on BurnGraphService because
// the service had grown to 5106 lines around one class, which made every
// authoring change a change to the same file as scheduling, claiming and
// recovery. Dependencies arrive explicitly, mirroring TemplateRegistry, so the
// authoring rules can be read — and exercised — without a live runtime.

import {
  BurnGraphError,
  IdentifierSchema,
  type CheckSpec,
  type GraphSpec,
  type GraphSummary,
  type ProjectConfig,
  type TemplateInstantiationReceipt,
  type TemplateInstantiationRequest,
} from "./contracts.ts";
import { validateCheckSpec } from "./gate.ts";
import { writeCheckSpec, writeGraphSpec } from "./project.ts";
import { json, numberValue, stringValue, type Row } from "./sql.ts";
import { BurnGraphDatabase } from "./storage.ts";
import { TemplateRegistry } from "./template-service.ts";
import { validateGraphSpec, type ValidatedGraph } from "./validator.ts";

export interface GraphAuthoringOptions {
  readonly root: string;
  readonly config: ProjectConfig;
  readonly database: BurnGraphDatabase;
  readonly timestamp: () => string;
  readonly loadGraph: (graphId: string, revision?: number) => ValidatedGraph;
  readonly loadCheck: (checkId: string, revision?: number) => CheckSpec;
  // Listing Graphs reports each Graph's latest Run, so authoring needs a narrow
  // read into runtime state. These two are the entire extent of that coupling.
  readonly summaryForRun: (runId: string) => GraphSummary;
  readonly tryResolveRun: (reference: string) => string | null;
}

export class GraphAuthoring {
  constructor(private readonly options: GraphAuthoringOptions) {}

  validateGraph(input: unknown): GraphSpec {
    return validateGraphSpec(input).spec;
  }

  applyGraph(input: unknown): GraphSpec {
    const validated = validateGraphSpec(input);
    const spec = validated.spec;
    this.validateCheckReferences(spec);
    this.validateHierarchyReferences(spec);
    const at = this.options.timestamp();
    this.options.database.immediate(() => {
      const latest = this.options.database.db
        .query(
          `SELECT revision
             FROM graph_specs
            WHERE graph_id = ?
            ORDER BY revision DESC
            LIMIT 1`,
        )
        .get(spec.id) as Row | null;
      if (latest && numberValue(latest, "revision") >= spec.revision) {
        throw new BurnGraphError(
          "STALE_GRAPH_REVISION",
          `Graph ${spec.id} already has revision ${numberValue(latest, "revision")}`,
          true,
          { submittedRevision: spec.revision },
        );
      }
      this.options.database.db
        .query(
          `INSERT INTO graph_specs (
             graph_id, revision, document_json, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(spec.id, spec.revision, json(spec), at);
    });
    try {
      writeGraphSpec(this.options.root, spec);
    } catch (error) {
      this.options.database.immediate(() => {
        this.options.database.db
          .query(
            `DELETE FROM graph_specs
              WHERE graph_id = ? AND revision = ?`,
          )
          .run(spec.id, spec.revision);
      });
      throw error;
    }
    return spec;
  }

  instantiateTemplate(
    request: TemplateInstantiationRequest,
  ): TemplateInstantiationReceipt {
    return new TemplateRegistry({
      root: this.options.root,
      database: this.options.database,
      timestamp: () => this.options.timestamp(),
      validateGraph: (input) => this.validateGraph(input),
      validateReferences: (spec) => {
        this.validateCheckReferences(spec);
        this.validateHierarchyReferences(spec);
      },
    }).instantiate(request);
  }

  validateHierarchyReferences(spec: GraphSpec): void {
    if (spec.schemaVersion !== 2) return;

    let descendantCount = 0;
    const visit = (
      current: GraphSpec,
      ancestors: ReadonlySet<string>,
      depth: number,
    ): void => {
      for (const node of current.nodes) {
        if (node.type !== "subgraph" || node.mode !== "static") continue;
        for (const child of node.children ?? []) {
          descendantCount += 1;
          if (depth + 1 > this.options.config.maxHierarchyDepth) {
            throw new BurnGraphError(
              "HIERARCHY_LIMIT",
              `Graph ${spec.id} exceeds hierarchy depth ${this.options.config.maxHierarchyDepth}`,
              false,
              {
                graphId: spec.id,
                depth: depth + 1,
                limit: this.options.config.maxHierarchyDepth,
              },
            );
          }
          if (descendantCount > this.options.config.maxUnfinishedDescendants) {
            throw new BurnGraphError(
              "HIERARCHY_LIMIT",
              `Graph ${spec.id} exceeds ${this.options.config.maxUnfinishedDescendants} static descendants`,
              false,
              {
                graphId: spec.id,
                descendants: descendantCount,
                limit: this.options.config.maxUnfinishedDescendants,
              },
            );
          }
          if (ancestors.has(child.graphId)) {
            throw new BurnGraphError(
              "HIERARCHY_CYCLE",
              `Graph ${child.graphId} repeats in a static ancestry chain`,
              false,
              {
                graphId: child.graphId,
                parentGraphId: current.id,
                nodeId: node.id,
              },
            );
          }
          const childSpec = this.options.loadGraph(
            child.graphId,
            child.revision,
          ).spec;
          visit(
            childSpec,
            new Set([...ancestors, child.graphId]),
            depth + 1,
          );
        }
      }
    };

    visit(spec, new Set([spec.id]), 0);
  }

  listGraphs(): readonly {
    readonly id: string;
    readonly title: string;
    readonly goal: string;
    readonly revision: number;
    readonly latestRun: GraphSummary | null;
  }[] {
    return this.options.database.read(() => {
      const rows = this.options.database.db
        .query(
          `SELECT s.graph_id, s.revision, s.document_json
             FROM graph_specs s
             JOIN (
               SELECT graph_id, MAX(revision) AS revision
                 FROM graph_specs
                GROUP BY graph_id
             ) latest
               ON latest.graph_id = s.graph_id
              AND latest.revision = s.revision
            ORDER BY s.graph_id`,
        )
        .all() as Row[];
      return rows.map((row) => {
        const spec = validateGraphSpec(
          JSON.parse(stringValue(row, "document_json")),
        ).spec;
        const latestRun = this.options.tryResolveRun(spec.id);
        return {
          id: spec.id,
          title: spec.title,
          goal: spec.goal,
          revision: spec.revision,
          latestRun: latestRun ? this.options.summaryForRun(latestRun) : null,
        };
      });
    });
  }

  getGraph(graphId: string): GraphSpec {
    return this.options.loadGraph(graphId).spec;
  }

  validateCheck(input: unknown): CheckSpec {
    return validateCheckSpec(input);
  }

  applyCheck(input: unknown): CheckSpec {
    const spec = validateCheckSpec(input);
    const at = this.options.timestamp();
    this.options.database.immediate(() => {
      const latest = this.options.database.db
        .query(
          `SELECT revision
             FROM check_specs
            WHERE check_id = ?
            ORDER BY revision DESC
            LIMIT 1`,
        )
        .get(spec.id) as Row | null;
      if (latest && numberValue(latest, "revision") >= spec.revision) {
        throw new BurnGraphError(
          "STALE_CHECK_REVISION",
          `Check ${spec.id} already has revision ${numberValue(latest, "revision")}`,
          true,
          { submittedRevision: spec.revision },
        );
      }
      this.options.database.db
        .query(
          `INSERT INTO check_specs (
             check_id, revision, document_json, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(spec.id, spec.revision, json(spec), at);
    });
    try {
      writeCheckSpec(this.options.root, spec);
    } catch (error) {
      this.options.database.immediate(() => {
        this.options.database.db
          .query(
            `DELETE FROM check_specs
              WHERE check_id = ? AND revision = ?`,
          )
          .run(spec.id, spec.revision);
      });
      throw error;
    }
    return spec;
  }

  listChecks(): readonly CheckSpec[] {
    return this.options.database.read(() => {
      const rows = this.options.database.db
        .query(
          `SELECT c.document_json
             FROM check_specs c
             JOIN (
               SELECT check_id, MAX(revision) AS revision
                 FROM check_specs
                GROUP BY check_id
             ) latest
               ON latest.check_id = c.check_id
              AND latest.revision = c.revision
            ORDER BY c.check_id`,
        )
        .all() as Row[];
      return rows.map((row) =>
        validateCheckSpec(JSON.parse(stringValue(row, "document_json"))),
      );
    });
  }

  getCheck(checkId: string, revision?: number): CheckSpec {
    return this.options.loadCheck(checkId, revision);
  }

  cloneGraph(sourceId: string, targetId: string, title?: string): GraphSpec {
    IdentifierSchema.parse(targetId);
    const source = this.options.loadGraph(sourceId).spec;
    return this.applyGraph({
      ...source,
      id: targetId,
      title: title ?? `${source.title} copy`,
      revision: 1,
    });
  }

  validateCheckReferences(spec: GraphSpec): void {
    for (const node of spec.nodes) {
      if (node.type !== "gate" || !node.check) continue;
      this.options.loadCheck(node.check.id, node.check.revision);
    }
  }

}
