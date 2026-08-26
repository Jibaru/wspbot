/**
 * Checks that the configured models exist and accept the exact parameters this app sends.
 *
 * Switching models is cheap to do and easy to get subtly wrong: a tier may not be enabled on the
 * account, or may reject `reasoningEffort`, `textVerbosity`, structured output, image input or a
 * transparent background. Each of those fails at the worst moment — mid-conversation — so they
 * are exercised here instead.
 *
 * Costs a few small calls plus one image generation, so it is opt-in:
 *   npm run models-check
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, generateObject, generateImage, tool, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

const env = Object.fromEntries(
  readFileSync("C:/Users/Ignac/Documentos/Github/wspbot/.env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const openai = createOpenAI({ apiKey: env["OPENAI_API_KEY"]! });
const CHAT = env["BOT_MODEL"] ?? "gpt-5.6";
const VISION = env["BOT_VISION_MODEL"] ?? CHAT;
const IMAGE = env["BOT_IMAGE_MODEL"] ?? "gpt-image-1";

let failures = 0;
const ok = (label: string, detail = "") => console.log("  PASS", label, detail);
const bad = (label: string, err: unknown) => {
  failures++;
  console.log("  FAIL", label, "—", err instanceof Error ? err.message.slice(0, 160) : String(err));
};

const main = async () => {
  console.log(`\nchat model: ${CHAT}`);
  try {
    // The same shape a real turn sends: a tool, web search, effort and verbosity.
    const result = await generateText({
      model: openai(CHAT),
      system: "You are terse.",
      messages: [{ role: "user", content: "Use the ping tool, then say the word done." }],
      tools: {
        web_search: openai.tools.webSearch({ searchContextSize: "medium" }),
        ping: tool({
          description: "Returns pong.",
          inputSchema: z.object({}),
          execute: async () => "pong",
        }),
      },
      stopWhen: stepCountIs(4),
      providerOptions: { openai: { reasoningEffort: env["BOT_EFFORT"] ?? "low", textVerbosity: "low" } },
    });
    ok("accepts tools, web search, effort and verbosity", `(${result.usage.outputTokens} out)`);
    if (result.text.trim()) ok("produced text after the tool call", JSON.stringify(result.text.slice(0, 40)));
    else bad("produced text after the tool call", "empty");
  } catch (err) {
    bad("chat model", err);
  }

  console.log(`\nvision model: ${VISION}`);
  try {
    const dir = mkdtempSync(join(tmpdir(), "models-check-"));
    const png = join(dir, "in.png");
    execFileSync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=256x256:rate=1:duration=1",
      "-frames:v", "1", png,
    ]);
    // Exactly the sticker-description call: structured output over an image.
    const { object, usage } = await generateObject({
      model: openai(VISION),
      schema: z.object({ label: z.string(), description: z.string() }),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Name and describe this image in a few words." },
            { type: "file", data: readFileSync(png), mediaType: "image/png" },
          ],
        },
      ],
    });
    ok("accepts image input with structured output", `(${usage.outputTokens} out)`);
    ok("returned an object", JSON.stringify(object.label.slice(0, 30)));
  } catch (err) {
    bad("vision model", err);
  }

  console.log(`\nimage model: ${IMAGE}`);
  try {
    const result = await generateImage({
      model: openai.image(IMAGE),
      prompt: "a small red circle, sticker art, flat colour",
      size: "1024x1024",
      providerOptions: {
        openai: { background: "transparent", outputFormat: "png", quality: "medium" },
      },
    });
    const png = Buffer.from(result.image.uint8Array);
    // Colour type 6 is RGBA, 4 is grey+alpha; anything else means the background is opaque.
    const colourType = png[25];
    ok("generated an image", `${(png.length / 1024).toFixed(0)}KB`);
    if (colourType === 6 || colourType === 4) ok("transparent background supported");
    else bad("transparent background", `png colour type ${colourType}`);
    if (result.warnings.length) console.log("    warnings:", JSON.stringify(result.warnings));
  } catch (err) {
    bad("image model", err);
  }

  console.log(failures === 0 ? "\nall models usable\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
};

void main();
