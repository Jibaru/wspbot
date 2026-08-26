/**
 * Exercises lib/sticker-maker against real files: a wide static image and a wide video standing
 * in for a WhatsApp "GIF". Verifies the output is a 512x512 WebP, that animated input really
 * produces an animated WebP, and that both land under WhatsApp's size ceilings.
 *
 * Needs ffmpeg on PATH. Run with:
 *   npx tsx --conditions=react-server scripts/sticker-check.ts
 * (the condition makes `server-only` resolve to its no-op build outside Next).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toSticker, firstFrame } from "../lib/sticker-maker.js";

const dir = mkdtempSync(join(tmpdir(), "sticker-check-"));
const ff = (args: string[]) =>
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);

/** Deliberately non-square, so the 512x512 padding is actually exercised. */
ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=4", "-pix_fmt", "yuv420p", join(dir, "in.mp4")]);
ff(["-f", "lavfi", "-i", "testsrc=size=800x400:rate=1:duration=1", "-frames:v", "1", join(dir, "in.png")]);

/** Reads the WebP container directly — ffprobe cannot parse animated WebP. */
const inspect = (b: Buffer) => {
  let off = 12;
  let frames = 0;
  let canvas = "?";
  const chunks: string[] = [];
  while (off + 8 <= b.length) {
    const cc = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (cc === "ANMF") frames++;
    if (cc === "VP8X") {
      const p = b.subarray(off + 8, off + 8 + size);
      canvas = `${(p[4]! | (p[5]! << 8) | (p[6]! << 16)) + 1}x${(p[7]! | (p[8]! << 8) | (p[9]! << 16)) + 1}`;
    }
    if (!chunks.includes(cc)) chunks.push(cc);
    off += 8 + size + (size % 2);
  }
  return {
    isWebp: b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
    frames: frames || 1,
    canvas,
    kb: +(b.length / 1024).toFixed(1),
    chunks,
  };
};

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, pass ? "" : `— got ${JSON.stringify(actual)}`);
};

console.log("\nanimated (mp4, as WhatsApp sends a GIF):");
const anim = inspect(await toSticker(readFileSync(join(dir, "in.mp4")), true));
console.log("   ", JSON.stringify(anim));
check("is a webp", anim.isWebp, true);
check("512x512 canvas", anim.canvas, "512x512");
check("actually animated", anim.frames > 1, true);
check("under WhatsApp's 500KB ceiling", anim.kb < 500, true);

console.log("\nstatic (png):");
const still = inspect(await toSticker(readFileSync(join(dir, "in.png")), false));
console.log("   ", JSON.stringify(still));
check("is a webp", still.isWebp, true);
check("512x512 canvas", still.canvas, "512x512");
check("single frame", still.frames, 1);
check("under WhatsApp's 100KB ceiling", still.kb < 100, true);
check("has an alpha channel for the padding", still.chunks.includes("ALPH"), true);

console.log("\nfirst frame (used to describe animated stickers):");
const frame = await firstFrame(readFileSync(join(dir, "in.mp4")));
check("is a png", frame.subarray(1, 4).toString("ascii"), "PNG");
console.log("    png bytes:", frame.length);

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
