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

import {
  boundedInteger,
  group,
  readJsonInput,
  success,
  withService,
} from "./support.ts";

export function registerAuthoring(): void {
  const graph = group("graph", "author and inspect GraphSpec JSON");

  graph
    .command("validate")
    .description("validate a GraphSpec without writing it")
    .requiredOption("--input <file>", "JSON file or - for stdin")
    .action(async (options: { input: string }) => {
      success(
        "graph.validate",
        validateGraphSpec(await readJsonInput(options.input)).spec,
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
      success("graph.apply", spec, {
        nextActions: [
          {
            id: "start-run",
            command: `burn-graph run start ${spec.id} --actor primary`,
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
      success("graph.clone", spec, {
        nextActions: [
          {
            id: "start-run",
            command: `burn-graph run start ${spec.id} --actor primary`,
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
        nextActions: receipt.graphs.map((graphReceipt) => ({
          id: `start:${graphReceipt.graphId}`,
          command:
            `burn-graph run start ${graphReceipt.graphId} --actor primary`,
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
      success(
        "check.validate",
        validateCheckSpec(await readJsonInput(options.input)),
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
      success("check.apply", spec, {
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
