import { describe, expect, test } from "bun:test";

import {
  GRAPH_EXAMPLE_KINDS,
  graphExample,
  graphSchemaDocument,
} from "../../apps/cli/src/authoring.ts";
import { validateGraphSpec } from "@burn-graph/core";
import {
  TemplateInstantiationInputSchema,
  generateTemplate,
  showTemplate,
} from "@burn-graph/templates";

describe("installed CLI authoring contract", () => {
  test("returns one complete bounded GraphSpec schema", () => {
    const schema = graphSchemaDocument() as any;
    expect(schema.acceptedGraphSpecVersions).toEqual([1, 2]);
    expect(schema.jsonSchema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(schema.jsonSchema.oneOf).toHaveLength(2);
    expect(schema.fieldGuide.prompt.runtime).toContain("GraphSpec v2");
    expect(schema.recovery.map((entry: any) => entry.error)).toEqual([
      "INVALID_JSON",
      "INVALID_GRAPH",
      "INVALID_INPUT_PATH",
    ]);
    expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(256 * 1024);
  });

  test("keeps all five examples complete and accepted by the real validator", () => {
    expect(GRAPH_EXAMPLE_KINDS).toEqual([
      "flat",
      "decision",
      "hierarchy",
      "gate",
      "wait",
    ]);
    for (const kind of GRAPH_EXAMPLE_KINDS) {
      const example = graphExample(kind);
      expect(validateGraphSpec(example.graph).spec).toEqual(example.graph);
      expect(example.application.file).toBeDefined();
      expect(example.application.stdin).toBeDefined();
    }
  });

  test("proves an incomplete example judges red", () => {
    const complete = graphExample("flat").graph;
    expect(() =>
      validateGraphSpec({
        ...complete,
        nodes: complete.nodes.filter((node) => node.type !== "end"),
      }),
    ).toThrow();
  });

  test("returns one directly valid complete input for every template", () => {
    for (
      const templateId of [
        "delivery",
        "vertical-slice",
        "poc",
        "bugfix",
        "review-repair",
        "release",
      ]
    ) {
      const shown = showTemplate(templateId);
      expect(
        TemplateInstantiationInputSchema.parse(shown.exampleInput),
      ).toEqual(shown.exampleInput);
      expect(
        generateTemplate(templateId, shown.exampleInput).graphs,
      ).toHaveLength(1);
      expect((shown.inputSchema as any).$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
    }
  });
});
