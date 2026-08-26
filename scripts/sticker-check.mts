/**
 * Exercises the sticker pipeline against real files and real network calls:
 *
 * - lib/sticker-maker: does a wide image or video become a 512x512 WebP, and does animated
 *   input actually produce an animated WebP?
 * - lib/fetch-media: are private addresses refused before any connection is made, and does a
 *   real remote GIF survive the round trip?
 *
 * Needs ffmpeg on PATH and (for the last section) network. Run with:
 *   npm run sticker-check
 * The `--conditions=react-server` flag in that script makes `server-only` resolve to its no-op
 * build, so these modules can be imported outside Next.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toSticker, firstFrame } from "../lib/sticker-maker.js";
import { fetchMedia, looksAnimated, isPrivateAddress } from "../lib/fetch-media.js";

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

const main = async () => {
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

  console.log("\nSSRF guard — addresses that must never be reachable:");
  for (const [ip, blocked] of [
    ["127.0.0.1", true],
    ["169.254.169.254", true], // cloud metadata
    ["10.0.0.5", true],
    ["172.16.0.1", true],
    ["192.168.1.1", true],
    ["100.64.0.1", true], // carrier-grade NAT
    ["0.0.0.0", true],
    ["::1", true],
    ["fd00::1", true],
    ["::ffff:10.0.0.1", true], // IPv4 wearing an IPv6 hat
    ["8.8.8.8", false],
    ["1.1.1.1", false],
  ] as const) {
    check(`${ip} blocked=${blocked}`, isPrivateAddress(ip), blocked);
  }

  console.log("\nSSRF guard — URLs refused before any connection:");
  for (const url of [
    "http://127.0.0.1:8787/",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/",
    "file:///etc/passwd",
    "http://[::1]/",
  ]) {
    let refused = false;
    try {
      await fetchMedia(url);
    } catch {
      refused = true;
    }
    check(`refuses ${url}`, refused, true);
  }

  console.log("\nanimated detection from bytes:");
  const gif = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(16)]);
  check("GIF89a magic beats an unhelpful content-type", looksAnimated(gif, "application/octet-stream"), true);
  check("png is static", looksAnimated(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png"), false);
  check("video content-type", looksAnimated(Buffer.alloc(16), "video/mp4"), true);

  console.log("\nreal remote GIF -> sticker (needs network):");
  try {
    const remote = await fetchMedia(
      "https://upload.wikimedia.org/wikipedia/commons/2/2c/Rotating_earth_%28large%29.gif",
    );
    console.log(`    downloaded ${(remote.bytes.length / 1024).toFixed(0)}KB as ${remote.contentType}`);
    const animated = looksAnimated(remote.bytes, remote.contentType);
    check("detected as animated", animated, true);
    const out = inspect(await toSticker(remote.bytes, animated));
    console.log("   ", JSON.stringify(out));
    check("512x512", out.canvas, "512x512");
    check("animated webp out", out.frames > 1, true);
    check("under 500KB", out.kb < 500, true);
  } catch (err) {
    // Network flakiness should not fail the suite; the offline checks above still ran.
    console.log("    SKIPPED:", err instanceof Error ? err.message : err);
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
};

void main();
