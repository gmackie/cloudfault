/**
 * `--name value` / `--name=value` / `--flag` parsing; repeated flags accumulate.
 * Names in `booleans` never consume the following argument, so
 * `ci --strict a.mjs` keeps `a.mjs` positional.
 */
export function parseFlags(args, { booleans = [] } = {}) {
  const flags = {};
  const positional = [];
  const boolean = new Set(booleans);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split("=", 2);
    const next = args[index + 1];
    const value = inline ?? (!boolean.has(name) && next !== undefined && !next.startsWith("--") ? (index++, next) : true);
    flags[name] = name in flags ? [flags[name], value].flat() : value;
  }
  return { flags, positional };
}

const DURATION_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** `500ms`, `90s`, `5m`, `1h`, or a bare number of seconds, as milliseconds. */
export function parseDuration(value, flag = "duration") {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value).trim());
  if (!match) throw new Error(`--${flag} expects a duration such as 90s, 5m, or 1h (got '${value}')`);
  return Math.round(Number(match[1]) * DURATION_UNITS[match[2] ?? "s"]);
}

/** A non-negative integer flag value. */
export function parseInteger(value, flag) {
  const number = Number(value);
  if (value === true || !Number.isInteger(number) || number < 0) throw new Error(`--${flag} expects a non-negative integer (got '${value}')`);
  return number;
}
