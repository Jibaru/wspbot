import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Downloading media from a URL the model chose.
 *
 * The URL is effectively attacker-influenced: anyone in a group can say "make a sticker from
 * http://…" and the model will pass it here. This code runs on a server that can reach the
 * container network and the cloud metadata endpoint, so an unguarded `fetch` is a
 * server-side request forgery hole. Everything below exists for that reason:
 *
 * - only http/https, so `file:` and friends cannot be reached at all
 * - every hostname resolved and checked against private ranges *before* connecting
 * - redirects followed by hand, re-validating each hop, since a public URL can redirect to
 *   169.254.169.254 and a normal `fetch` would follow it without telling you
 * - a hard byte cap enforced while streaming, so a slow infinite response cannot exhaust memory
 */

export class FetchMediaError extends Error {}

/** Generous for a GIF, far below anything that would threaten the container. */
const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

/**
 * Ranges that must never be reachable: loopback, private, link-local (which includes the cloud
 * metadata address), carrier-grade NAT, benchmarking, multicast and reserved space.
 */
const isPrivateIPv4 = (ip: string): boolean => {
  const p = ip.split(".").map(Number);
  const [a = 0, b = 0] = p;
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local, i.e. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0/24 protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
};

const isPrivateIPv6 = (ip: string): boolean => {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local
  if (v.startsWith("fe80")) return true; // link-local
  // IPv4 mapped (::ffff:10.0.0.1) is just IPv4 wearing a hat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);
  return false;
};

export const isPrivateAddress = (ip: string): boolean =>
  isIP(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);

/**
 * Resolve and reject anything that points inside the network.
 *
 * Every address the name resolves to is checked, not just the first — a host that returns one
 * public and one private address must not be usable.
 */
const assertPublic = async (url: URL): Promise<void> => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchMediaError(`refusing to fetch a ${url.protocol} URL`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new FetchMediaError("that address is inside the private network");
    }
    return;
  }

  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new FetchMediaError(`could not resolve ${host}`);
  }

  if (addresses.length === 0) throw new FetchMediaError(`could not resolve ${host}`);
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new FetchMediaError(`${host} resolves inside the private network`);
  }
};

/** Only things that could plausibly become a sticker. */
const ACCEPTABLE = /^(image|video)\//i;

export type RemoteMedia = { bytes: Buffer; contentType: string; url: string };

/**
 * Fetch remote media, following redirects by hand so each hop is validated.
 *
 * `fetch`'s own redirect handling is the problem being avoided: it would happily follow a
 * public URL to a private one, and by then the request has already been made.
 */
export const fetchMedia = async (raw: string): Promise<RemoteMedia> => {
  let current: URL;
  try {
    current = new URL(raw);
  } catch {
    throw new FetchMediaError("that is not a valid URL");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublic(current);

      const res = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          // Some CDNs serve a hotlink placeholder or 403 without these.
          "user-agent": "Mozilla/5.0 (compatible; wspbot/1.0)",
          accept: "image/*,video/*;q=0.9,*/*;q=0.5",
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new FetchMediaError(`redirect with no destination (${res.status})`);
        current = new URL(location, current); // relative Location headers are legal
        continue;
      }

      if (!res.ok) throw new FetchMediaError(`the server returned ${res.status}`);

      const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
      /**
       * Some CDNs serve media as octet-stream, so that is allowed through and left for ffmpeg
       * to reject. Anything that announces itself as HTML is a page, not a file — the usual
       * cause is a Tenor or Giphy *page* URL rather than the media itself.
       */
      if (contentType && !ACCEPTABLE.test(contentType) && contentType !== "application/octet-stream") {
        throw new FetchMediaError(
          contentType.includes("html")
            ? "that link is a web page, not the file itself — find the direct media URL"
            : `that URL is ${contentType}, not an image or video`,
        );
      }

      // Trust the header only as an early out; the real limit is enforced while reading.
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_BYTES) {
        throw new FetchMediaError(`that file is ${Math.round(declared / 1024 / 1024)}MB, too big`);
      }
      if (!res.body) throw new FetchMediaError("the server sent no content");

      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        // Enforced here rather than from content-length, which a server can simply lie about.
        if (total > MAX_BYTES) {
          controller.abort();
          throw new FetchMediaError("that file is too big");
        }
        chunks.push(Buffer.from(chunk));
      }

      const bytes = Buffer.concat(chunks);
      if (bytes.length === 0) throw new FetchMediaError("the file came back empty");
      return { bytes, contentType, url: current.toString() };
    }

    throw new FetchMediaError("too many redirects");
  } catch (err) {
    if (err instanceof FetchMediaError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new FetchMediaError("the download timed out");
    }
    throw new FetchMediaError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Whether the fetched bytes should be encoded as an animated sticker.
 *
 * The content type is a hint, not an answer — plenty of CDNs serve a GIF as octet-stream — so
 * the file's own magic bytes decide when the header is unhelpful. GIF89a is the animated
 * variant; a WebP is animated only if the container carries an ANIM chunk.
 */
export const looksAnimated = (bytes: Buffer, contentType: string): boolean => {
  if (/^video\//i.test(contentType)) return true;
  if (/gif/i.test(contentType)) return true;

  const magic = bytes.subarray(0, 6).toString("ascii");
  if (magic === "GIF89a" || magic === "GIF87a") return true;

  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return bytes.subarray(0, 1024).includes(Buffer.from("ANIM", "ascii"));
  }

  // mp4 and friends: an ftyp box in the first bytes.
  return bytes.subarray(4, 8).toString("ascii") === "ftyp";
};
