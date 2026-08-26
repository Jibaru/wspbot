import "server-only";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg, FfmpegError, inScratch } from "./ffmpeg";


/**
 * Turning what people send into WhatsApp stickers.
 *
 * A sticker is a 512x512 WebP. An *animated* sticker is an animated WebP — and what WhatsApp
 * calls a "GIF" is not a GIF at all, it is an mp4 with `gifPlayback` set. So the input can be a
 * JPEG, a PNG, a real GIF, or a video, and only one tool reads all of those and writes animated
 * WebP: ffmpeg with libwebp.
 *
 * The filter chain is the interesting part:
 *
 *   scale=...force_original_aspect_ratio=decrease  fit inside 512x512, never distort
 *   format=rgba                                    give pad an alpha channel to work with
 *   pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000  centre it on transparent, not black
 *
 * Without `format=rgba` the padding comes out opaque black, which looks like a letterboxed
 * photo rather than a sticker.
 */

/** WhatsApp's ceilings. Over these the sticker is rejected or silently mangled. */
const MAX_STATIC_BYTES = 100 * 1024;
const MAX_ANIMATED_BYTES = 500 * 1024;

/** Long enough to read as a loop, short enough to stay under the size ceiling. */
const MAX_SECONDS = 6;

const FIT =
  "scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000";

/**
 * Progressively cheaper encodes. The first that lands under the ceiling wins — a 4-second
 * animation at 15fps is usually fine, but a busy one has to give up frames or quality.
 */
const ANIMATED_LADDER = [
  { fps: 15, quality: 60 },
  { fps: 12, quality: 45 },
  { fps: 10, quality: 30 },
  { fps: 8, quality: 20 },
];

const STATIC_LADDER = [75, 55, 35];

/** Raised when the source cannot become a usable sticker. */
export class StickerError extends FfmpegError {}

/**
 * Convert to a sticker.
 *
 * `animated` decides which encoder path is taken; pass it true for videos and GIFs. ffmpeg
 * probes the input itself, so the source needs no extension and no declared type.
 */
export const toSticker = async (
  source: Buffer,
  animated: boolean,
): Promise<Buffer> =>
  inScratch(async (dir) => {
    const input = join(dir, "input");
    await writeFile(input, source);
    const output = join(dir, "sticker.webp");

    if (!animated) {
      for (const quality of STATIC_LADDER) {
        await ffmpeg([
          "-y", "-hide_banner", "-loglevel", "error",
          "-i", input,
          "-vf", FIT,
          "-c:v", "libwebp",
          "-lossless", "0",
          "-q:v", String(quality),
          "-preset", "picture",
          "-an",
          "-frames:v", "1",
          output,
        ]);
        const out = await readFile(output);
        if (out.length <= MAX_STATIC_BYTES) return out;
      }
      // Even the cheapest encode is too big — better a large sticker than none.
      return readFile(output);
    }

    for (const { fps, quality } of ANIMATED_LADDER) {
      await ffmpeg([
        "-y", "-hide_banner", "-loglevel", "error",
        // Before -i so the source is trimmed on the way in rather than fully decoded.
        "-t", String(MAX_SECONDS),
        "-i", input,
        "-vf", `fps=${fps},${FIT}`,
        // libwebp switches to the animated encoder on its own once there is more than one frame.
        "-c:v", "libwebp",
        "-lossless", "0",
        "-q:v", String(quality),
        "-loop", "0",
        "-preset", "default",
        "-an",
        output,
      ]);
      const out = await readFile(output);
      if (out.length <= MAX_ANIMATED_BYTES) return out;
    }

    const last = await readFile(output);
    if (last.length > MAX_ANIMATED_BYTES) {
      throw new StickerError(
        `animation is too detailed to fit in ${Math.round(MAX_ANIMATED_BYTES / 1024)}KB`,
      );
    }
    return last;
  });

/**
 * A single 512x512 frame, used to describe the sticker for the library.
 *
 * Vision models choke on animated WebP, so an animated sticker is described from its first
 * frame rather than from the file that actually gets sent.
 */
export const firstFrame = async (source: Buffer): Promise<Buffer> =>
  inScratch(async (dir) => {
    const input = join(dir, "input");
    await writeFile(input, source);
    const output = join(dir, "frame.png");
    await ffmpeg([
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", input,
      "-vf", FIT,
      "-frames:v", "1",
      output,
    ]);
    return readFile(output);
  });
