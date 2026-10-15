/**
 * Minimal ANSI styling for terminal reports. Renderers stay plain unless a
 * caller opts in, so saved artifacts and file reports never carry escapes.
 */

const codes = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
} as const;

export type ColorStyle = keyof typeof codes;

export interface ColorStreamLike {
  isTTY?: boolean;
}

export type ColorEnvironment = Readonly<Record<string, string | undefined>>;

function processEnv(): ColorEnvironment {
  const proc = (globalThis as { process?: { env?: ColorEnvironment } }).process;
  return proc?.env ?? {};
}

/**
 * Decide whether to emit ANSI color for a stream. `NO_COLOR` (any non-empty
 * value) disables, `FORCE_COLOR` enables unless it is `0`/`false`, otherwise
 * color follows `stream.isTTY` and is off for `TERM=dumb`.
 */
export function colorEnabled(stream?: ColorStreamLike, env: ColorEnvironment = processEnv()): boolean {
  if (env.NO_COLOR) return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force !== "false";
  if (env.TERM === "dumb") return false;
  return stream?.isTTY === true;
}

export type Painter = (style: ColorStyle | readonly ColorStyle[], text: string) => string;

/** A painter that wraps text in ANSI styles, or returns it unchanged when disabled. */
export function painter(enabled: boolean): Painter {
  if (!enabled) return (_style, text) => text;
  return (style, text) => {
    if (!text) return text;
    const styles = typeof style === "string" ? [style] : style;
    return styles.reduceRight((value, name) => {
      const [open, close] = codes[name];
      return `\u001b[${open}m${value}\u001b[${close}m`;
    }, text);
  };
}

/** Remove ANSI escape sequences, e.g. to compare colored output against plain text. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
