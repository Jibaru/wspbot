import "server-only";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Shared ffmpeg plumbing.
 *
 * Both the sticker encoder and the voice-note encoder need the same two things: run ffmpeg and
 * surface why it failed, and give each conversion a private directory so concurrent turns
 * cannot collide on a filename.
 */

const execFileAsync = promisify(execFile);

export class FfmpegError extends Error {}

export const ffmpeg = async (args: string[], timeoutMs = 60_000): Promise<void> => {
  try {
    await execFileAsync("ffmpeg", args, { timeout: timeoutMs, maxBuffer: 1 << 24 });
  } catch (err) {
    // ffmpeg explains itself on stderr; the last few lines are the useful part.
    const detail =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr).split("\n").slice(-4).join(" ").trim()
        : String(err);
    throw new FfmpegError(`ffmpeg failed: ${detail || "no output"}`);
  }
};

/** Each conversion gets its own directory, removed however the work ends. */
export const inScratch = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "wspbot-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};
