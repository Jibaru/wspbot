import "server-only";
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { config } from "./config";
import { wapi } from "./wapi";
import { fetchDecrypted } from "./inbound-media";
import * as summaries from "./summaries";
import * as usage from "./usage";
import type { Inbound } from "./mentions";

/**
 * Writing down what was said in a group being summarised.
 *
 * Separate from `lib/summaries.ts` so the data layer stays free of the model and of wapi — the
 * dashboard imports that, and it has no business pulling in either.
 *
 * The whole thing is best-effort. Recording is a background job attached to somebody else's
 * conversation: if describing a picture fails, the message is still worth keeping without the
 * description, and nothing here may ever throw into the webhook handler.
 */

/**
 * An image is described **once, on arrival**, and never again. Two constraints force it:
 * inbound media is encrypted and the decrypted URL dies within the hour, so a digest running
 * tomorrow cannot look at today's picture; and re-reading every image at digest time would cost
 * a vision call per image per run rather than one per image, ever.
 */
const describeImage = async (
  bytes: Buffer,
  mediaType: string,
  caption: string,
): Promise<string | null> => {
  try {
    const result = await generateObject({
      model: openai(config.visionModel()),
      schema: z.object({
        description: z
          .string()
          .describe(
            "One sentence: what the picture shows, and any text visible in it. This is all a later summary will know about it, so lead with whatever carries information — a screenshot's contents, a document's heading, a chart's point — rather than the composition.",
          ),
      }),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: caption
                ? `Someone posted this in a group chat with the caption: "${caption}". Describe the picture itself.`
                : "Someone posted this in a group chat. Describe it.",
            },
            // A `file` part, not `image`: the image part type is deprecated in the SDK.
            { type: "file", data: bytes, mediaType },
          ],
        },
      ],
    });

    await usage.record({ kind: "vision", model: config.visionModel(), usage: result.usage });
    return result.object.description.trim() || null;
  } catch (err) {
    console.warn(
      "[summaries] could not describe an image:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
};

/** WhatsApp's own kinds, narrowed to what a digest cares about. */
const kindOf = (message: Inbound): string => message.media?.kind ?? "text";

/**
 * Record one message.
 *
 * Called for every message in a recorded group, tagged or not — which is the entire point, and
 * also why the gate upstream is narrow. Errors are swallowed: this is somebody's conversation
 * being logged in the background, and it must never cost them a reply.
 */
export const record = async (message: Inbound): Promise<void> => {
  try {
    const kind = kindOf(message);
    const text = message.text ?? "";

    let mediaNote: string | null = null;
    let mediaUrl: string | null = null;

    /**
     * Only stills are described, and only stills are re-hosted. Video, audio and documents are
     * recorded as the fact that they happened: transcribing every voice note in a busy group is
     * a different feature with a different bill.
     */
    if (message.media && message.media.kind === "image" && !message.media.animated) {
      try {
        const bytes = await fetchDecrypted(message.media.node);
        const mediaType = message.media.mimetype ?? "image/jpeg";

        // Re-uploaded because the decrypted link expires; this one does not, so a digest hours
        // later can still attach the picture rather than only mentioning it.
        const [note, hosted] = await Promise.all([
          describeImage(bytes, mediaType, text),
          wapi
            .upload({
              base64: bytes.toString("base64"),
              mimetype: mediaType,
              fileName: `logged-${message.messageId}.jpg`,
            })
            .catch(() => null),
        ]);
        mediaNote = note;
        mediaUrl = hosted;
      } catch (err) {
        console.warn(
          "[summaries] could not read an image:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    await summaries.log({
      chat: message.chat,
      messageId: message.messageId,
      sender: message.sender ?? null,
      senderName: message.senderName ?? null,
      kind,
      text,
      mediaNote,
      mediaUrl,
      urls: summaries.extractUrls(text),
    });
  } catch (err) {
    console.warn(
      "[summaries] could not record a message:",
      err instanceof Error ? err.message : err,
    );
  }
};
