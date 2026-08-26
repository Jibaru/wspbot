/**
 * Guards the bug this file was written for: a video that shows a thumbnail and never plays,
 * on web and mobile alike.
 *
 * Being *a video* is not enough. WhatsApp plays H.264 in an MP4 with AAC audio; VP9/Opus in
 * WebM, HEVC and AV1 all arrive dead. Nothing about that is visible in a typecheck, or even in
 * a file that opens fine on the machine that made it.
 *
 * Verified with ffprobe rather than by trusting the extension:
 *   npm run video-check
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWhatsAppVideo } from "../lib/video.js";

const dir = mkdtempSync(join(tmpdir(), "video-check-"));
const ff = (args: string[]) =>
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, pass ? "" : `— got ${JSON.stringify(actual)}`);
};

const probe = (file: string) => {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=format_name",
    "-show_entries", "stream=codec_name,codec_type,pix_fmt,profile",
    "-of", "json",
    file,
  ]).toString();
  const parsed = JSON.parse(out) as {
    format?: { format_name?: string };
    streams?: Array<{ codec_name?: string; codec_type?: string; pix_fmt?: string; profile?: string }>;
  };
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  const audio = parsed.streams?.find((s) => s.codec_type === "audio");
  return {
    container: parsed.format?.format_name?.includes("mp4") ?? false,
    videoCodec: video?.codec_name,
    pixFmt: video?.pix_fmt,
    profile: video?.profile,
    audioCodec: audio?.codec_name,
  };
};

/**
 * `expectAudio` is false for a silent source. WhatsApp plays a video with no audio track
 * perfectly well, and inventing a silent one to satisfy a uniform assertion would be fixing the
 * test rather than the product — so the assertion follows the source instead.
 */
const verify = (label: string, bytes: Buffer, expectAudio = true) => {
  const file = join(dir, `${label.replace(/\W+/g, "-")}.mp4`);
  writeFileSync(file, bytes);
  const info = probe(file);
  console.log("   ", JSON.stringify(info), `${(bytes.length / 1024).toFixed(0)}KB`);
  // These together are what makes a video play on every client; three out of four does not.
  check(`${label}: mp4 container`, info.container, true);
  check(`${label}: h264`, info.videoCodec, "h264");
  check(`${label}: yuv420p`, info.pixFmt, "yuv420p");
  check(`${label}: baseline profile`, info.profile, "Constrained Baseline");
  check(
    `${label}: ${expectAudio ? "aac audio" : "no audio track, as in the source"}`,
    info.audioCodec,
    expectAudio ? "aac" : undefined,
  );
};

const main = async () => {
  // What a web search actually turns up, and what WhatsApp cannot play.
  console.log("\nVP9 + Opus in WebM (the failing case):");
  const webm = join(dir, "in.webm");
  ff([
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libvpx-vp9", "-b:v", "300k", "-c:a", "libopus", webm,
  ]);
  console.log("    source:", JSON.stringify(probe(webm)));
  verify("webm-sourced", await toWhatsAppVideo(readFileSync(webm)));

  console.log("\nsilent video (no audio track at all):");
  const silent = join(dir, "silent.mp4");
  ff([
    "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv444p", silent,
  ]);
  // 4:4:4 in, 4:2:0 out. Chroma subsampling is the point of this case; audio is absent by design.
  verify("silent-sourced", await toWhatsAppVideo(readFileSync(silent)), false);

  console.log("\noversized source is scaled down:");
  const big = join(dir, "big.mp4");
  ff([
    "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=3",
    "-c:v", "libx264", "-c:a", "aac", big,
  ]);
  const out = await toWhatsAppVideo(readFileSync(big));
  const file = join(dir, "scaled.mp4");
  writeFileSync(file, out);
  const width = Number(
    execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width", "-of", "csv=p=0", file]).toString().trim(),
  );
  console.log("    width:", width);
  check("scaled to 720 or less", width <= 720, true);
  check("under WhatsApp's 16MB ceiling", out.length < 16 * 1024 * 1024, true);

  rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
};

void main();
