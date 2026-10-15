import { colorEnabled, painter } from "@cloudfault/core";

/** Color stdout only on a TTY, honouring NO_COLOR / FORCE_COLOR. */
export const color = colorEnabled(process.stdout);
export const paint = painter(color);

export const pass = (text = "PASS") => paint(["bold", "green"], text);
export const fail = (text = "FAIL") => paint(["bold", "red"], text);
export const warn = (text = "WARN") => paint(["bold", "yellow"], text);
export const heading = (text) => paint(["bold", "cyan"], text);
export const label = (text) => paint("dim", text);
export const filePath = (text) => paint("cyan", text);
