// The authoring command groups: `graph`, `template` and `check`.
//
// These three share one concern — turning JSON documents into registered,
// revision-guarded specifications — and none of them touches a live Run. Keeping
// them together and apart from the runtime groups makes that boundary visible in
// the file layout rather than only in the help text.

import {
  validateCheckSpec,
  validateGraphSpec,
  type CheckSpec,
  type GraphSpec,
} from "@burn-graph/core";
import {
  generateTemplate,
  listTemplates,
  showTemplate,
} from "@burn-graph/templates";

import { createHash } from "node:crypto";

import {
  GRAPH_EXAMPLE_KINDS,
  graphExample,
  graphSchemaDocument,
} from "./authoring.ts";
import {
  boundedInteger,
  group,
  readJsonInput,
  success,
  withService,
} from "./support.ts";

// Validate and apply return a receipt rather than echoing the normalized spec
// back. The spec can be arbitrarily large — a 900-node Graph is legal — and
// echoing it made a successful validation exceed the CLI's own output budget
// (I0011). The digest lets a caller prove which document was accepted without
// receiving it again.
function documentDigest(value: unknown): {
  readonly documentBytes: number;
  readonly sha256: string;
} {
  const document = JSON.stringify(value);
  return {
    documentBytes: Buffer.byteLength(document),
    sha256: createHash("sha256").update(document).digest("hex"),
  };
}

function graphReceipt(
  spec: GraphSpec,
  registered = true,
): Readonly<Record<string, unknown>> {
  return {
    valid: true,
    schemaVersion: spec.schemaVersion,
    id: spec.id,
    title: spec.title,
    revision: spec.revision,
    maxActive: spec.maxActive,
    nodeCount: spec.nodes.length,
    ...documentDigest(spec),
    ...(registered ? { path: `.burn/graph/graphs/${spec.id}.json` } : {}),
  };
}

function checkReceipt(
  spec: CheckSpec,
  registered = true,
): Readonly<Record<string, unknown>> {
  return {
    valid: true,
    schemaVersion: spec.schemaVersion,
    id: spec.id,
    title: spec.title,
    revision: spec.revision,
    argvCount: spec.argv.length,
    timeoutMs: spec.timeoutMs,
    ...documentDigest(spec),
    ...(registered ? { path: `.burn/graph/checks/${spec.id}.json` } : {}),
  };
}

export function registerAuthoring(): void {
  const graph = group("graph", "author and inspect GraphSpec JSON");

  graph
    .command("schema")
    .description("return the complete versioned GraphSpec authoring schema")
    .action(() => {
      success("graph.schema", graphSchemaDocument(), {
        nextActions: [
          {
            id: "example",
            command: "burn-graph graph example goal",
            description: "Inspect one complete valid GraphSpec.",
          },
        ],
      });
    });

  graph
    .command("example")
    .description("return one complete valid GraphSpec example")
    .argument("<kind>", `one of ${GRAPH_EXAMPLE_KINDS.join("|")}`)
    .action((kind: string) => {
      success("graph.example", graphExample(kind), {
        nextActions: [
          {
            id: "validate-file",
            command: "burn-graph graph validate --input graph.json",
            description:
              "Save data.graph inside the project and validate that relative file.",
          },
          {
            id: "validate-stdin",
            command: "burn-graph graph validate --input -",
            description: "Send data.graph only through stdin.",
          },
        ],
      });
    });

  graph
    .command("validate")
    .description("validate a GraphSpec without writing it")
    .requiredOption("--input <file>", "JSON file or - for stdin")
    .action(async (options: { input: string }) => {
      const spec = validateGraphSpec(await readJsonInput(options.input)).spec;
      success(
        "graph.validate",
        graphReceipt(spec, false),
        {
          nextActions: [
            {
              id: "apply-graph",
              command: `burn-graph graph apply --input ${options.input}`,
              description: "Register the validated GraphSpec.",
            },
          ],
        },
      );
    });

  graph
    .command("apply")
    .description("validate and register a new GraphSpec revision")
    .requiredOption("--input <file>", "JSON file or - for stdin")
    .action(async (options: { input: string }) => {
      const input = await readJsonInput(options.input);
      const spec = withService((service) => service.applyGraph(input));
      success("graph.apply", graphReceipt(spec), {
        nextActions: [
          {
            id: "start-run",
            command:
              spec.schemaVersion === 3
                ? `burn-graph goal start ${spec.id}`
                : `burn-graph run start ${spec.id}`,
            description: "Start the Graph and receive its first Assignments.",
          },
        ],
      });
    });

  graph
    .command("list")
    .description("list registered GraphSpecs and latest Run summaries")
    .action(() => {
      success("graph.list", withService((service) => service.listGraphs()));
    });

  graph
    .command("show")
    .description("show the latest normalized GraphSpec")
    .argument("<graph>", "Graph ID")
    .action((graphId: string) => {
      success("graph.show", withService((service) => service.getGraph(graphId)));
    });

  graph
    .command("clone")
    .description("clone a GraphSpec under a new ID")
    .argument("<source>", "source Graph ID")
    .argument("<target>", "target Graph ID")
    .option("--title <title>", "target title")
    .action((source: string, target: string, options: { title?: string }) => {
      const spec = withService((service) =>
        service.cloneGraph(source, target, options.title),
      );
      success("graph.clone", graphReceipt(spec), {
        nextActions: [
          {
            id: "start-run",
            command:
              spec.schemaVersion === 3
                ? `burn-graph goal start ${spec.id}`
                : `burn-graph run start ${spec.id}`,
            description: "Start the cloned Graph.",
          },
        ],
      });
    });

  const template = group(
    "template",
    "inspect and instantiate immutable package workflow templates",
  );

  template
    .command("list")
    .description("list the six immutable package template descriptors")
    .action(() => {
      success("template.list", {
        schemaVersion: 1,
        templates: listTemplates(),
        count: listTemplates().length,
      }, {
        nextActions: [{
          id: "show-template",
          command: "burn-graph template show <template>",
          description: "Inspect one bounded input contract.",
        }],
      });
    });

  template
    .command("show")
    .description("show one package template and its bounded input contract")
    .argument("<template>", "package template ID")
    .action((templateId: string) => {
      success("template.show", showTemplate(templateId), {
        nextActions: [{
          id: "instantiate-template",
          command:
            `burn-graph template instantiate ${templateId} --input template-input.json`,
          description: "Generate and atomically register the local Graph revision.",
        }],
      });
    });

  template
    .command("instantiate")
    .description("atomically generate and register one package template")
    .argument("<template>", "package template ID")
    .requiredOption("--input <file>", "JSON file or - for stdin")
    .option("--idempotency-key <key>", "stable retry key")
    .action(async (
      templateId: string,
      options: { input: string; idempotencyKey?: string },
    ) => {
      const generation = generateTemplate(
        templateId,
        await readJsonInput(options.input),
        options.idempotencyKey,
      );
      const receipt = withService((service) =>
        service.instantiateTemplate(generation),
      );
      success("template.instantiate", receipt, {
        nextActions: receipt.graphs.map((generated) => ({
          id: `start:${generated.graphId}`,
          command: `burn-graph run start ${generated.graphId}`,
          description: "Start the generated Graph and receive its first prompt.",
        })),
      });
    });

  const check = group("check", "author immutable registered machine Checks");

  check
    .command("validate")
    .description("validate a CheckSpec without writing it")
    .requiredOption("--input <file>", "JSON file or - for stdin")
    .action(async (options: { input: string }) => {
      const spec = validateCheckSpec(await readJsonInput(options.input));
      success(
        "check.validate",
        checkReceipt(spec, false),
        {
          nextActions: [{
            id: "apply-check",
            command: `burn-graph check apply --input ${options.input}`,
            description: "Register the validated immutable Check revision.",
          }],
        },
      );
    });

  check
    .command("apply")
    .description("validate and register a new immutable Check revision")
    .requiredOption("--input <file>", "JSON file or - for stdin")
    .action(async (options: { input: string }) => {
      const input = await readJsonInput(options.input);
      const spec = withService((service) =>
        service.applyCheck(input),
      );
      success("check.apply", checkReceipt(spec), {
        nextActions: [{
          id: "apply-graph",
          command: "burn-graph graph apply --input graph.json",
          description: "Register a Graph that pins this Check revision.",
        }],
      });
    });

  check
    .command("list")
    .description("list latest registered Check revisions")
    .action(() => {
      success("check.list", withService((service) => service.listChecks()));
    });

  check
    .command("show")
    .description("show one normalized Check revision")
    .argument("<check>", "Check ID")
    .option(
      "--revision <number>",
      "exact immutable revision",
      boundedInteger(2_147_483_647),
    )
    .action((checkId: string, options: { revision?: number }) => {
      success(
        "check.show",
        withService((service) =>
          service.getCheck(checkId, options.revision),
        ),
      );
    });

}
