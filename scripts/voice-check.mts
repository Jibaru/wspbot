/**
 * Guards the bug this file was written for: the bot used to send mp3, which plays in WhatsApp
 * Web and not in the mobile app. A voice note has to be Opus in an Ogg container, mono, 48kHz.
 *
 * Verifies the encoder output with ffprobe rather than trusting the extension. Runs offline
 * against a synthetic tone; add OPENAI_API_KEY to also put a real TTS clip through it.
 *
 *   npm run voice-check
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toVoiceNote, VOICE_NOTE_MIMETYPE } from "../lib/audio.js";

const dir = mkdtempSync(join(tmpdir(), "voice-check-"));

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, pass ? "" : `— got ${JSON.stringify(actual)}`);
};

/** ffprobe is the arbiter here: the container and codec are the whole point. */
const probe = (file: string) => {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=format_name",
    "-show_entries", "stream=codec_name,sample_rate,channels",
    "-of", "default=nw=1",
    file,
  ]).toString();
  const get = (k: string) => new RegExp(`${k}=(.+)`).exec(out)?.[1]?.trim();
  return {
    format: get("format_name"),
    codec: get("codec_name"),
    sampleRate: get("sample_rate"),
    channels: get("channels"),
  };
};

const verify = (label: string, bytes: Buffer) => {
  const file = join(dir, `${label.replace(/\W+/g, "-")}.ogg`);
  writeFileSync(file, bytes);
  const info = probe(file);
  console.log("   ", JSON.stringify(info), `${(bytes.length / 1024).toFixed(1)}KB`);
  // The mobile app needs all four of these; mp3 satisfies none of them.
  check(`${label}: ogg container`, info.format, "ogg");
  check(`${label}: opus codec`, info.codec, "opus");
  check(`${label}: 48kHz`, info.sampleRate, "48000");
  check(`${label}: mono`, info.channels, "1");
};

const main = async () => {
  console.log("\nmimetype sent to wapi:");
  check("is audio/ogg", VOICE_NOTE_MIMETYPE, "audio/ogg");

  console.log("\nsynthetic tone (wav in):");
  const wav = join(dir, "tone.wav");
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-ar", "24000", "-ac", "1", wav,
  ]);
  verify("tone", await toVoiceNote(readFileSync(wav)));

  // mp3 in, opus out — the exact path a re-encode of the old output would take.
  console.log("\nmp3 source (what used to be sent directly):");
  const mp3 = join(dir, "tone.mp3");
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", wav, mp3]);
  verify("mp3-sourced", await toVoiceNote(readFileSync(mp3)));

  if (process.env["OPENAI_API_KEY"]) {
    console.log("\nreal TTS clip:");
    const { generateSpeech } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({ apiKey: process.env["OPENAI_API_KEY"]! });
    const speech = await generateSpeech({
      model: openai.speech("gpt-4o-mini-tts"),
      text: "Hola, esto es una nota de voz de prueba.",
      voice: "alloy",
      outputFormat: "wav",
    });
    console.log("    tts returned", speech.audio.mediaType, `${(speech.audio.uint8Array.length / 1024).toFixed(0)}KB`);
    verify("tts", await toVoiceNote(Buffer.from(speech.audio.uint8Array)));
  } else {
    console.log("\nreal TTS clip: SKIPPED (no OPENAI_API_KEY)");
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
};

void main();
