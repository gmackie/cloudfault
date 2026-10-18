#!/usr/bin/env node

/**
 * Records the README's example report: docs/media/report.webm plus a
 * report.png poster (the final frame).
 *
 * VHS drives a real terminal through docs/media/report.tape and writes raw
 * frames; ffmpeg encodes them here rather than through VHS's own encoder,
 * which some VHS/ffmpeg pairings silently skip. VHS only honours a frame
 * directory given as an absolute in-tape Output, and silently writes nothing
 * if that directory already exists, so a copy of the tape pointing at a
 * not-yet-created directory is recorded.
 *
 * Usage (needs `vhs` and `ffmpeg` on PATH):
 *   npm run media:report
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const media = join(root, "docs/media");
const framerate = "50"; // VHS's default capture rate
// Raw frames have no margin; pad them in the "GitHub Dark" theme background.
const pad = "format=rgb24,pad=iw+64:ih+56:32:28:color=0x0f1114";

const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });

const work = mkdtempSync(join(tmpdir(), "cloudfault-media-"));
const frames = join(work, "frames");
const tape = join(work, "report.tape");
writeFileSync(tape, `Output ${JSON.stringify(`${frames}/`)}\n${readFileSync(join(media, "report.tape"), "utf8")}`);
run("vhs", [tape]);

const textFrames = readdirSync(frames).filter((name) => name.startsWith("frame-text-")).sort();
if (!textFrames.length) throw new Error(`VHS wrote no frames to ${frames}`);
const hasCursor = existsSync(join(frames, "frame-cursor-00001.png"));

const inputs = ["-framerate", framerate, "-i", join(frames, "frame-text-%05d.png")];
if (hasCursor) inputs.push("-framerate", framerate, "-i", join(frames, "frame-cursor-%05d.png"));
const filter = ["-filter_complex", hasCursor ? `[0][1]overlay,${pad}` : pad];

run("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y", ...inputs, ...filter,
  "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "36", "-row-mt", "1", "-pix_fmt", "yuv420p",
  join(media, "report.webm"),
]);

const last = textFrames.at(-1).replace("frame-text-", "");
const posterInputs = [join(frames, `frame-text-${last}`)];
if (hasCursor) posterInputs.push(join(frames, `frame-cursor-${last}`));
run("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  ...posterInputs.flatMap((file) => ["-i", file]),
  ...filter,
  "-frames:v", "1", join(media, "report.png"),
]);

rmSync(work, { recursive: true, force: true });
for (const name of ["report.webm", "report.png"]) {
  console.log(`${name}: ${(statSync(join(media, name)).size / 1024).toFixed(0)} KiB`);
}
