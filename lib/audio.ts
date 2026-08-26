import "server-only";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg, inScratch } from "./ffmpeg";

/**
 * Encoding audio the way WhatsApp voice notes are actually encoded.
 *
 * This exists because of a bug worth remembering: the bot originally sent mp3, which plays
 * perfectly in WhatsApp Web and often not at all in the mobile app. The browser will decode
 * whatever the OS can; the app expects a voice note to be Opus in an Ogg container and does not
 * reliably fall back. "It works on my screen" hid it completely.
 *
 * The four settings below are the format, not preferences:
 *
 *   libopus   the codec WhatsApp voice notes use
 *   ogg       the container it is carried in
 *   48000 Hz  Opus's native rate; anything else is resampled on the way in
 *   1 channel voice notes are mono, and stereo doubles the size for nothing
 */

export const VOICE_NOTE_MIMETYPE = "audio/ogg";
export const VOICE_NOTE_FILENAME = "voice.ogg";

/** Speech at 32k mono is transparent enough; the ceiling is WhatsApp's patience, not fidelity. */
const BITRATE = "32k";

export const toVoiceNote = async (source: Buffer): Promise<Buffer> =>
  inScratch(async (dir) => {
    const input = join(dir, "input");
    const output = join(dir, VOICE_NOTE_FILENAME);
    await writeFile(input, source);

    await ffmpeg([
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", input,
      "-vn",
      "-c:a", "libopus",
      "-b:a", BITRATE,
      "-ar", "48000",
      "-ac", "1",
      // Tunes the encoder for speech rather than music.
      "-application", "voip",
      "-f", "ogg",
      output,
    ]);

    return readFile(output);
  });
