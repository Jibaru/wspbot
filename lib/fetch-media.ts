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

/**
 * The eight 16-bit groups of an IPv6 address, or null if it does not parse.
 *
 * Written out rather than pattern-matched because the textual forms of the same address are not
 * interchangeable: `::ffff:169.254.169.254` and `::ffff:a9fe:a9fe` are one address, and the
 * WHATWG URL parser rewrites the first into the second. A check that matched the dotted spelling
 * saw a link-local address; the same check saw the hex spelling as public internet.
 */
const groupsOf = (ip: string): number[] | null => {
  let text = ip.toLowerCase();

  // A trailing dotted quad is the low 32 bits written the other way round.
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted?.[1]) {
    const octets = dotted[1].split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const piece of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };

  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (!head || !tail) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array(missing).fill(0), ...tail];
};

const isPrivateIPv6 = (ip: string): boolean => {
  const g = groupsOf(ip);
  // Unparseable is refused rather than allowed: this decision only ever gates outbound requests.
  if (!g) return true;

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;

  if (g.every((n) => n === 0)) return true; // ::
  if (g.slice(0, 7).every((n) => n === 0) && g7 === 1) return true; // ::1

  /*
   * Anything carrying an IPv4 address in its low 32 bits is that IPv4 address as far as a
   * connection is concerned — mapped (::ffff:0:0/96), the deprecated compatible form, and the
   * NAT64 well-known prefix 64:ff9b::/96 alike. Each is a way to spell 169.254.169.254.
   */
  const embedded = () => {
    const [a, b] = [g6 >> 8, g6 & 0xff];
    const [c, d] = [g7 >> 8, g7 & 0xff];
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
  };
  const zeroTop = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroTop && (g5 === 0xffff || g5 === 0)) return embedded();
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return embedded();
  }

  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  return false;
};

export const isPrivateAddress = (ip: string): boolean =>
  isIP(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);

/**
 * Resolve and reject anything that points inside the network.
 *
 * Every address the name resolves to is checked, not just the first — a host that returns one
 * public and one private address must not be usable.
 *
 * Exported because the screenshot browser needs exactly this decision for every URL it is about
 * to open, and a second implementation of "is this address safe" is a second thing to get wrong.
 */
export const assertPublic = async (url: URL): Promise<void> => {
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
