import {
  BurnGraphError,
  GraphSpecSchema,
  type GraphSpec,
  type NextEdgeSpec,
  type NodeSpec,
} from "./contracts.ts";

export interface ValidatedGraph {
  readonly spec: GraphSpec;
  readonly nodesById: ReadonlyMap<string, NodeSpec>;
  readonly forwardEdges: readonly GraphEdgeRef[];
  readonly loopEdges: readonly GraphEdgeRef[];
}

export interface GraphEdgeRef {
  readonly id: string;
  readonly index: number;
  readonly from: string;
  readonly to: string;
  readonly route: string | null;
  readonly label: string | null;
  readonly maxTraversals: number | null;
}

export interface GraphValidationOptions {
  // Persisted revisions may predate a stricter admission rule. New writes stay
  // strict, while this narrow read compatibility keeps existing Runs operable.
  readonly allowLegacyDormantLoopTarget?: boolean;
}

function edgeRef(
  node: NodeSpec,
  edge: NextEdgeSpec,
  index: number,
): GraphEdgeRef {
  return {
    id: `${node.id}:${index}:${edge.to}`,
    index,
    from: node.id,
    to: edge.to,
    route: edge.route ?? null,
    label: edge.label ?? null,
    maxTraversals: edge.maxTraversals ?? null,
  };
}

function reachable(
  start: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }
  return seen;
}

function topologicalCycle(
  nodes: readonly string[],
  edges: readonly GraphEdgeRef[],
): readonly string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const current = adjacency.get(edge.from) ?? [];
    current.push(edge.to);
    adjacency.set(edge.from, current);
  }
  const active = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): readonly string[] | null => {
    if (active.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) return null;
    active.add(id);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(id);
    visited.add(id);
    return null;
  };
  for (const node of nodes) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

export function validateGraphSpec(
  input: unknown,
  options: GraphValidationOptions = {},
): ValidatedGraph {
  const parsed = GraphSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new BurnGraphError(
      "INVALID_GRAPH",
      "GraphSpec validation failed",
      false,
      {
        issues: parsed.error.issues,
      },
    );
  }
  const spec = parsed.data;

  const systemTypes = new Set(["subgraph", "gate", "wait"]);
  if (
    spec.schemaVersion === 1 &&
    spec.nodes.some((node) => systemTypes.has(node.type))
  ) {
    throw new BurnGraphError(
      "INVALID_GRAPH",
      "GraphSpec v1 cannot declare v2 System Nodes",
    );
  }
  if (spec.schemaVersion === 1) {
    const extended = spec.nodes.find(
      (node) =>
        node.resources !== undefined ||
        node.prompt.role.length > 0 ||
        node.prompt.lockedContracts.length > 0 ||
        node.prompt.writablePaths.length > 0 ||
        node.prompt.forbidden.length > 0 ||
        node.prompt.runtime.length > 0 ||
        node.work !== undefined,
    );
    if (extended) {
      throw new BurnGraphError(
        "INVALID_GRAPH",
        `GraphSpec v1 node ${extended.id} cannot declare v2 prompt or resource fields`,
        false,
        { nodeId: extended.id },
      );
    }
  }
  if (
    spec.schemaVersion === 2 &&
    spec.nodes.some((node) => node.work !== undefined)
  ) {
    throw new BurnGraphError(
      "INVALID_GRAPH",
      "GraphSpec v2 cannot declare v3 Work contracts",
    );
  }

  for (const node of spec.nodes) {
    if (node.type === "subgraph") {
      const childCount =
        node.mode === "static"
          ? (node.children?.length ?? 0)
          : node.maxChildren;
      if (childCount !== undefined && childCount > 32) {
        throw new BurnGraphError(
          "HIERARCHY_LIMIT",
          `Subgraph ${node.id} exceeds the 32-child package limit`,
          false,
          { nodeId: node.id, childCount, limit: 32 },
        );
      }
      if (
        node.mode === "static" &&
        node.children?.some((child) => child.graphId === spec.id)
      ) {
        throw new BurnGraphError(
          "HIERARCHY_CYCLE",
          `Subgraph ${node.id} cannot reference its own GraphSpec`,
          false,
          { nodeId: node.id, graphId: spec.id },
        );
      }
      const allowed = new Set(["success", "failure", "cancelled"]);
      const invalid = node.next.find(
        (edge) => edge.route === undefined || !allowed.has(edge.route),
      );
      if (invalid) {
        throw new BurnGraphError(
          "INVALID_ROUTE",
          `Subgraph ${node.id} has unsupported route ${invalid.route ?? ""}`,
          false,
          { routes: [...allowed] },
        );
      }
      if (!node.next.some((edge) => edge.route === "success")) {
        throw new BurnGraphError(
          "INVALID_ROUTE",
          `Subgraph ${node.id} requires a success route`,
          false,
          { routes: [...allowed] },
        );
      }
    } else if (node.type === "gate") {
      const routes = new Set(node.next.map((edge) => edge.route));
      if (routes.size !== 2 || !routes.has("pass") || !routes.has("fail")) {
        throw new BurnGraphError(
          "INVALID_ROUTE",
          `Gate ${node.id} requires exact pass and fail routes`,
          false,
          { routes: ["pass", "fail"] },
        );
      }
    } else if (node.type === "wait") {
      const declared = new Set([
        ...(node.signal?.routes ?? []),
        ...(node.signal?.timeout ? [node.signal.timeout.route] : []),
      ]);
      const actual = new Set(node.next.map((edge) => edge.route));
      if (
        actual.size !== declared.size ||
        [...declared].some((route) => !actual.has(route))
      ) {
        throw new BurnGraphError(
          "INVALID_ROUTE",
          `Wait ${node.id} routes must match its Signal contract`,
          false,
          { routes: [...declared] },
        );
      }
    }
  }

  const nodesById = new Map<string, NodeSpec>();
  for (const node of spec.nodes) {
    if (nodesById.has(node.id)) {
      throw new BurnGraphError(
        "DUPLICATE_NODE",
        `Graph contains duplicate node ${node.id}`,
      );
    }
    nodesById.set(node.id, node);
  }

  let finalGoalReviewId: string | null = null;
  if (spec.schemaVersion === 3) {
    const evidenceIds = new Set(
      spec.goal.successEvidence.map((evidence) => evidence.id),
    );
    const executionOwners = new Map<string, string>();
    const reviewNodes: NodeSpec[] = [];

    for (const node of spec.nodes) {
      const assignable =
        node.type === "task" ||
        node.type === "decision" ||
        (node.type === "subgraph" && node.mode === "dynamic");
      if (assignable && node.work === undefined) {
        throw new BurnGraphError(
          "INVALID_GRAPH",
          `GraphSpec v3 assignable node ${node.id} requires a Work contract`,
          false,
          { nodeId: node.id },
        );
      }
      if (!assignable && node.work !== undefined) {
        throw new BurnGraphError(
          "INVALID_GRAPH",
          `Non-assignable node ${node.id} cannot declare a Work contract`,
          false,
          { nodeId: node.id },
        );
      }
      if (node.work === undefined) continue;
      const unknownEvidence = node.work.evidence.filter(
        (evidenceId) => !evidenceIds.has(evidenceId),
      );
      if (unknownEvidence.length > 0) {
        throw new BurnGraphError(
          "INVALID_GRAPH",
          `Work ${node.id} references unknown Goal evidence`,
          false,
          { nodeId: node.id, evidenceIds: unknownEvidence },
        );
      }
      if (node.work.kind === "execute") {
        for (const evidenceId of node.work.evidence) {
          const existingOwner = executionOwners.get(evidenceId);
          if (existingOwner !== undefined) {
            throw new BurnGraphError(
              "INVALID_GRAPH",
              `Goal evidence ${evidenceId} has more than one execution Work owner`,
              false,
              { evidenceId, ownerWorkIds: [existingOwner, node.id] },
            );
          }
          executionOwners.set(evidenceId, node.id);
        }
        continue;
      }
      if (node.type !== "decision") {
        throw new BurnGraphError(
          "INVALID_GRAPH",
          `Review Work ${node.id} must be a Decision`,
          false,
          { nodeId: node.id },
        );
      }
      const routes = new Set(node.next.map((edge) => edge.route));
      const revise = node.next.find((edge) => edge.route === "revise");
      if (
        routes.size !== 2 ||
        !routes.has("pass") ||
        revise === undefined ||
        revise.maxTraversals === undefined
      ) {
        throw new BurnGraphError(
          "INVALID_ROUTE",
          `Review Work ${node.id} requires exact pass and bounded revise routes`,
          false,
          { nodeId: node.id, routes: ["pass", "revise"] },
        );
      }
      reviewNodes.push(node);
    }

    for (const review of reviewNodes) {
      const reviewed = review.work!.reviewOf.map((nodeId) => {
        const node = nodesById.get(nodeId);
        if (!node || node.work?.kind !== "execute") {
          throw new BurnGraphError(
            "INVALID_GRAPH",
            `Review Work ${review.id} references non-execution Work ${nodeId}`,
            false,
            { nodeId: review.id, reviewOf: nodeId },
          );
        }
        return node;
      });
      const reviewedEvidence = new Set(
        reviewed.flatMap((node) => node.work?.evidence ?? []),
      );
      const unsupported = review.work!.evidence.filter(
        (evidenceId) => !reviewedEvidence.has(evidenceId),
      );
      if (unsupported.length > 0) {
        throw new BurnGraphError(
          "INVALID_GRAPH",
          `Review Work ${review.id} covers evidence its reviewed Work does not own`,
          false,
          { nodeId: review.id, evidenceIds: unsupported },
        );
      }
    }

    const unowned = [...evidenceIds].filter(
      (evidenceId) => !executionOwners.has(evidenceId),
    );
    if (unowned.length > 0) {
      throw new BurnGraphError(
        "INVALID_GRAPH",
        "Every Goal evidence requirement needs execution Work ownership",
        false,
        { evidenceIds: unowned },
      );
    }
    const finalReviews = reviewNodes.filter((node) =>
      [...evidenceIds].every((evidenceId) =>
        node.work?.evidence.includes(evidenceId),
      ),
    );
    if (finalReviews.length !== 1) {
      throw new BurnGraphError(
        "INVALID_GRAPH",
        "GraphSpec v3 requires exactly one final Review Work covering every Goal evidence requirement",
        false,
        {
          evidenceIds: [...evidenceIds],
          reviewNodes: finalReviews.map((node) => node.id),
        },
      );
    }
    finalGoalReviewId = finalReviews[0]!.id;
  }

  const starts = spec.nodes.filter((node) => node.type === "start");
  const ends = spec.nodes.filter((node) => node.type === "end");
  if (starts.length !== 1 || ends.length !== 1) {
    throw new BurnGraphError(
      "INVALID_TERMINALS",
      "Graph requires exactly one Start and one End",
      false,
      { starts: starts.map(({ id }) => id), ends: ends.map(({ id }) => id) },
    );
  }

  const allEdges: GraphEdgeRef[] = [];
  for (const node of spec.nodes) {
    const targets = new Set<string>();
    node.next.forEach((edge, index) => {
      if (!nodesById.has(edge.to)) {
        throw new BurnGraphError(
          "UNKNOWN_NEXT",
          `Node ${node.id} points to unknown node ${edge.to}`,
        );
      }
      if (edge.to === node.id) {
        throw new BurnGraphError(
          "SELF_EDGE",
          `Node ${node.id} cannot point to itself`,
        );
      }
      const key = `${edge.route ?? ""}:${edge.to}`;
      if (targets.has(key)) {
        throw new BurnGraphError(
          "DUPLICATE_NEXT",
          `Node ${node.id} repeats Next ${edge.to}`,
        );
      }
      targets.add(key);
      allEdges.push(edgeRef(node, edge, index));
    });
  }

  const loopEdges = allEdges.filter((edge) => edge.maxTraversals !== null);
  const forwardEdges = allEdges.filter((edge) => edge.maxTraversals === null);
  const cycle = topologicalCycle(
    spec.nodes.map(({ id }) => id),
    forwardEdges,
  );
  if (cycle) {
    throw new BurnGraphError(
      "UNBOUNDED_CYCLE",
      `Every cycle requires an explicit maxTraversals edge: ${cycle.join(" -> ")}`,
      false,
      { cycle },
    );
  }

  const forwardAdjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();
  for (const edge of forwardEdges) {
    const next = forwardAdjacency.get(edge.from) ?? [];
    next.push(edge.to);
    forwardAdjacency.set(edge.from, next);
    const previous = reverseAdjacency.get(edge.to) ?? [];
    previous.push(edge.from);
    reverseAdjacency.set(edge.to, previous);
  }

  const startId = starts[0]!.id;
  const endId = ends[0]!.id;
  const initiallyReachable = reachable(startId, forwardAdjacency);
  for (const edge of loopEdges) {
    const source = nodesById.get(edge.from)!;
    const target = nodesById.get(edge.to)!;
    if (source.type !== "decision" || target.type !== "task") {
      throw new BurnGraphError(
        "INVALID_LOOP",
        `Bounded loop ${edge.from} -> ${edge.to} must go from Decision to ancestor Task`,
      );
    }
    if (!reachable(edge.to, forwardAdjacency).has(edge.from)) {
      throw new BurnGraphError(
        "INVALID_LOOP",
        `Loop target ${edge.to} is not a forward ancestor of ${edge.from}`,
      );
    }
    if (
      !initiallyReachable.has(edge.to) &&
      options.allowLegacyDormantLoopTarget !== true
    ) {
      throw new BurnGraphError(
        "INVALID_LOOP",
        `Loop target ${edge.to} is not reachable from Start before the loop opens`,
        false,
        { sourceId: edge.from, targetId: edge.to },
      );
    }
  }

  const allAdjacency = new Map<string, string[]>();
  for (const edge of allEdges) {
    const next = allAdjacency.get(edge.from) ?? [];
    next.push(edge.to);
    allAdjacency.set(edge.from, next);
  }
  if (finalGoalReviewId !== null) {
    const withoutFinalReview = new Map<string, string[]>();
    for (const edge of allEdges) {
      if (edge.from === finalGoalReviewId || edge.to === finalGoalReviewId) {
        continue;
      }
      const next = withoutFinalReview.get(edge.from) ?? [];
      next.push(edge.to);
      withoutFinalReview.set(edge.from, next);
    }
    if (reachable(starts[0]!.id, withoutFinalReview).has(ends[0]!.id)) {
      throw new BurnGraphError(
        "INVALID_GRAPH",
        `Goal completion can bypass final Review Work ${finalGoalReviewId}`,
        false,
        { nodeId: finalGoalReviewId },
      );
    }
  }
  const fromStart = reachable(startId, allAdjacency);
  const canReachEnd = reachable(endId, reverseAdjacency);
  const unreachable = spec.nodes
    .map(({ id }) => id)
    .filter((id) => !fromStart.has(id));
  if (unreachable.length > 0) {
    throw new BurnGraphError(
      "UNREACHABLE_NODE",
      `Nodes are unreachable from Start: ${unreachable.join(", ")}`,
      false,
      { nodes: unreachable },
    );
  }
  const deadEnds = spec.nodes
    .map(({ id }) => id)
    .filter((id) => !canReachEnd.has(id));
  if (deadEnds.length > 0) {
    throw new BurnGraphError(
      "NO_FORWARD_END",
      `Nodes have no non-loop path to End: ${deadEnds.join(", ")}`,
      false,
      { nodes: deadEnds },
    );
  }

  const inbound = new Map<string, number>();
  for (const edge of allEdges) {
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }
  for (const node of spec.nodes) {
    if (node.type === "join" && (inbound.get(node.id) ?? 0) < 2) {
      throw new BurnGraphError(
        "INVALID_JOIN",
        `Join ${node.id} requires at least two incoming edges`,
      );
    }
  }

  return { spec, nodesById, forwardEdges, loopEdges };
}

export function loopBodyNodeIds(
  graph: ValidatedGraph,
  sourceId: string,
  targetId: string,
): Set<string> {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const edge of graph.forwardEdges) {
    const next = forward.get(edge.from) ?? [];
    next.push(edge.to);
    forward.set(edge.from, next);
    const previous = reverse.get(edge.to) ?? [];
    previous.push(edge.from);
    reverse.set(edge.to, previous);
  }
  const fromTarget = reachable(targetId, forward);
  const toSource = reachable(sourceId, reverse);
  return new Set([...fromTarget].filter((id) => toSource.has(id)));
}
