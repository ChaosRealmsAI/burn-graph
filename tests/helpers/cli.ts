import path from "node:path";

export function confinedInputArgs(
  projectRoot: string,
  args: readonly string[],
): string[] {
  const root = path.resolve(projectRoot);
  return args.map((value, index) => {
    if (
      args[index - 1] !== "--input" ||
      value === "-" ||
      !path.isAbsolute(value)
    ) {
      return value;
    }
    const relative = path.relative(root, path.resolve(value));
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return value;
    }
    return relative;
  });
}
