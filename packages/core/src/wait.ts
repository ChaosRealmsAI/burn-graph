import {
  BurnGraphError,
  SignalResolutionInputSchema,
  type CompletionInput,
  type SignalResolutionInput,
} from "./contracts.ts";

export function validateSignalResolutionInput(
  input: unknown,
): SignalResolutionInput {
  const parsed = SignalResolutionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new BurnGraphError(
      "INVALID_SIGNAL_INPUT",
      "Signal resolution input validation failed",
      false,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

export function waitDeadline(
  createdAt: string,
  afterMs: number | undefined,
): string | null {
  if (afterMs === undefined) return null;
  return new Date(new Date(createdAt).getTime() + afterMs).toISOString();
}

export function waitCompletion(
  route: string,
  input: SignalResolutionInput,
): CompletionInput {
  return {
    summary: input.summary,
    evidence: input.evidence,
    route,
  };
}
