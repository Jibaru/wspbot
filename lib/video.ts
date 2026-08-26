import "server-only";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg, inScratch } from "./ffmpeg";

/**
 * Making a video WhatsApp will actually play.
 *
 * The same trap as voice notes, one layer up: a file being *a video* is not enough. WhatsApp
 * plays H.264 in an MP4 with AAC audio, and a great deal of what the web serves is not that —
 * VP9/Opus in WebM, HEVC, AV1, 4:4:4 chroma. Handed one of those it shows a thumbnail that never
 * starts, on every client, which is exactly the symptom that prompted this.
 *
 * So nothing is forwarded by URL any more. The bytes are fetched, re-encoded to a profile
 * every client can decode, and uploaded. The settings are not preferences:
 *
 *   libx264 baseline   the most widely decodable H.264 profile
 *   yuv420p            4:2:0 chroma; 4:4:4 and 10-bit are rejected by many decoders
 *   aac 44.1kHz        Opus and Vorbis in an MP4 will not play
 *   +faststart         moves the index to the front so it plays before it finishes downloading
 */

/** WhatsApp refuses anything much larger, and a huge file is a bad message anyway. */
const MAX_BYTES = 16 * 1024 * 1024;

/** Long enough for a clip, short enough that a feature film cannot be pasted in. */
const MAX_SECONDS = 180;

/**
 * Tried in order until one fits. Dropping resolution saves far more than raising the quantiser,
 * so the ladder walks resolution down first.
 */
const LADDER = [
  { width: 720, crf: 28 },
  { width: 640, crf: 30 },
  { width: 480, crf: 32 },
  { width: 360, crf: 34 },
];

export const toWhatsAppVideo = async (source: Buffer): Promise<Buffer> =>
  inScratch(async (dir) => {
    const input = join(dir, "input");
    const output = join(dir, "video.mp4");
    await writeFile(input, source);

    for (const { width, crf } of LADDER) {
      await ffmpeg(
        [
          "-y", "-hide_banner", "-loglevel", "error",
          // Before -i so a long source is trimmed on the way in rather than fully decoded.
          "-t", String(MAX_SECONDS),
          "-i", input,
          "-c:v", "libx264",
          "-profile:v", "baseline",
          "-level", "3.1",
          "-pix_fmt", "yuv420p",
          "-crf", String(crf),
          "-preset", "veryfast",
          // -2 keeps the height even, which H.264 requires; never upscales past the source.
          "-vf", `scale='min(${width},iw)':-2`,
          "-c:a", "aac",
          "-b:a", "128k",
          "-ar", "44100",
          "-ac", "2",
          "-movflags", "+faststart",
          output,
        ],
        180_000,
      );

      const encoded = await readFile(output);
      if (encoded.length <= MAX_BYTES) return encoded;
    }

    // Even the cheapest rung was too big: better a clear refusal than a message that never plays.
    const last = await readFile(output);
    if (last.length > MAX_BYTES) {
      throw new Error(
        `that video is too long or too detailed to fit in ${Math.round(MAX_BYTES / 1024 / 1024)}MB`,
      );
    }
    return last;
  });
