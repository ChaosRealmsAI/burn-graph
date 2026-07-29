import { BurnGraphError } from "./contracts.ts";

type SqlValue = string | number | bigint | null;

export type Row = Record<string, SqlValue>;

export function stringValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new BurnGraphError("CORRUPT_STATE", `Expected ${key} to be text`);
  }
  return value;
}

export function optionalString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new BurnGraphError("CORRUPT_STATE", `Expected ${key} to be nullable text`);
  }
  return value;
}

export function numberValue(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new BurnGraphError("CORRUPT_STATE", `Expected ${key} to be numeric`);
}

export function optionalNumber(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new BurnGraphError("CORRUPT_STATE", `Expected ${key} to be nullable number`);
}

export function parseJson<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function stableJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      Object.getPrototypeOf(candidate) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.entries(candidate)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}
