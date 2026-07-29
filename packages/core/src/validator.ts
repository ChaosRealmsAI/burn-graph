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

export function validateGraphSpec(input: unknown): ValidatedGraph {
  const parsed = GraphSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new BurnGraphError("INVALID_GRAPH", "GraphSpec validation failed", false, {
      issues: parsed.error.issues,
    });
  }
  const spec = parsed.data;
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
  }

  const startId = starts[0]!.id;
  const endId = ends[0]!.id;
  const allAdjacency = new Map<string, string[]>();
  for (const edge of allEdges) {
    const next = allAdjacency.get(edge.from) ?? [];
    next.push(edge.to);
    allAdjacency.set(edge.from, next);
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
