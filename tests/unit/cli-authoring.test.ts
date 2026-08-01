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

// Known-bad first, for both halves of the surface. These tests exist to prove the
// oracles below can fail: `validateGraphSpec` and the template input schema are
// what every green assertion here delegates to, so an accepting stub would make
// the rest of this file pass while the installed CLI shipped broken examples.
describe("installed CLI authoring contract judges known-bad input red", () => {
  test("judges an incomplete example red", () => {
    const complete = graphExample("flat").graph;
    expect(() =>
      validateGraphSpec({
        ...complete,
        nodes: complete.nodes.filter((node) => node.type !== "end"),
      }),
    ).toThrow();
  });

  test("judges a semantically wrong template input red", () => {
    const shown = showTemplate("delivery");
    // Identifiers must start with a letter, so this is rejected by the same
    // schema the green case parses, not by an unrelated type error.
    expect(() =>
      TemplateInstantiationInputSchema.parse({
        ...(shown.exampleInput as Record<string, unknown>),
        graphId: "9-not-an-identifier",
      }),
    ).toThrow();
    expect(() =>
      TemplateInstantiationInputSchema.parse({
        ...(shown.exampleInput as Record<string, unknown>),
        goal: "",
      }),
    ).toThrow();
    expect(() => generateTemplate("no-such-template", shown.exampleInput))
      .toThrow();
  });
});

describe("installed CLI authoring contract", () => {
  test("returns one complete bounded GraphSpec schema", () => {
    const schema = graphSchemaDocument() as any;
    expect(schema.acceptedGraphSpecVersions).toEqual([1, 2, 3]);
    expect(schema.jsonSchema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(schema.jsonSchema.oneOf).toHaveLength(3);
    expect(schema.fieldGuide.prompt.runtime).toContain("GraphSpec v2");
    expect(schema.recovery.map((entry: any) => entry.error)).toEqual([
      "INVALID_JSON",
      "INVALID_GRAPH",
      "INVALID_INPUT_PATH",
    ]);
    expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(256 * 1024);
  });

  test("keeps all six examples complete and accepted by the real validator", () => {
    expect(GRAPH_EXAMPLE_KINDS).toEqual([
      "flat",
      "decision",
      "goal",
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
