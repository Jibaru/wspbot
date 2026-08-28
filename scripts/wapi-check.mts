/**
 * Exercises the vendored wapi SDK against the real API.
 *
 * A typecheck proves the shapes agree with the OpenAPI document; it proves nothing about the
 * envelopes, which are the part of this API that is not guessable — `/api/status` answers with a
 * bare object and no `success` key, `/api/upload` puts `publicUrl` at the top level rather than
 * under `data`, and everything else nests. Those are exactly what a client swap can quietly get
 * wrong while still compiling.
 *
 * Safe against production. It uploads one 1x1 PNG, and it sends one message — to a sandbox
 * session it creates and then deletes, whose number sits under country code 999, which is
 * unassigned and cannot route anywhere. **Nothing reaches a real chat.**
 *
 *   npm run wapi-check
 *
 * Needs WAPI_API_KEY, and uses WAPI_PAT for the credential-type check when it is set.
 */

import { wapi, WapiError, WapiAuthError } from "../lib/wapi.js";
import { WapiClient } from "../lib/wapi-sdk/index.js";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, detail);
};

const baseUrl = process.env["WAPI_BASE_URL"] ?? "https://api.wapi.crafter.run";

if (!process.env["WAPI_API_KEY"]) {
  console.error("WAPI_API_KEY is not set — nothing to check against.");
  process.exit(1);
}

console.log(`\nwapi at ${baseUrl}`);

/** The bare-envelope case: `{ status }` with no `success` wrapper. */
console.log("\nstatus:");
const status = await wapi.status();
check("status is a non-empty string", typeof status === "string" && status.length > 0, `— ${status}`);
check("status is lowercase, unlike connect's", status === status.toLowerCase());

/** The `data`-wrapped case. */
console.log("\nidentity:");
const me = await wapi.me();
check("id is a JID", typeof me.id === "string" && me.id.includes("@"), `— ${me.id}`);
check("lid is present or explicitly null", "lid" in me);
check("name is present or explicitly null", "name" in me);

const again = await wapi.meCached();
check("meCached agrees with me", again.id === me.id);

/**
 * The third envelope: `publicUrl` at the top level. Uploading a 1x1 PNG is the smallest thing
 * that exercises it, and the returned link is then fetched to prove it is real rather than
 * merely well-shaped.
 */
console.log("\nupload:");
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const url = await wapi.upload({
  base64: PNG_1x1,
  mimetype: "image/png",
  fileName: "wapi-check.png",
});
check("upload returns a URL", typeof url === "string" && /^https?:\/\//.test(url), `— ${url}`);

const fetched = await fetch(url);
check("the uploaded URL actually serves the bytes", fetched.ok, `— ${fetched.status}`);
const bytes = new Uint8Array(await fetched.arrayBuffer());
check(
  "and they are the PNG that went up",
  bytes.length === Buffer.from(PNG_1x1, "base64").length,
  `— ${bytes.length} bytes`,
);

/**
 * Two credentials, not interchangeable, and the wrong *type* returns 403 rather than 401. Worth
 * asserting because the distinction is the difference between "rotate the token" and "you are
 * using the wrong one", and the SDK is what now draws it.
 */
console.log("\ncredential types:");
const pat = process.env["WAPI_PAT"];
if (!pat) {
  console.log("  SKIP no WAPI_PAT set");
} else {
  const wrong = new WapiClient({ apiKey: pat, baseUrl });
  try {
    await wrong.status();
    check("a PAT is refused on a session route", false, "— it was accepted");
  } catch (err) {
    const e = err as WapiError;
    check("a PAT on a session route throws WapiError", e instanceof WapiError, `— ${e.status}`);
    check(
      "and it is 403, the wrong-credential-type signal, not 401",
      e instanceof WapiAuthError && e.isWrongCredentialType,
      `— status ${e.status}`,
    );
  }
}

/** A bad key must be an auth failure, not a crash or a silent empty result. */
console.log("\nbad credentials:");
try {
  await new WapiClient({ apiKey: "definitely-not-a-key", baseUrl }).status();
  check("a bogus key is refused", false, "— it was accepted");
} catch (err) {
  const e = err as WapiError;
  check("a bogus key throws WapiError", e instanceof WapiError, `— status ${e.status}`);
  check("with a status of 401 or 403", e.status === 401 || e.status === 403);
}

/**
 * Sending, against a sandbox rather than a real chat.
 *
 * `send` is the path everything else in this app depends on, and it is the one thing a read-only
 * check cannot reach — every other route either reads or, in the case of upload, writes something
 * nobody sees. The sandbox exists for exactly this: a fake number under country code 999, which
 * is unassigned and cannot route anywhere, going through the same routes and the same code as a
 * real session.
 *
 * The session is deleted in `finally`, so a failure mid-way does not leave one behind.
 */
if (!pat) {
  console.log("\nsending: SKIP no WAPI_PAT set");
} else {
  console.log("\nsending (sandbox):");
  const account = new WapiClient({ apiKey: pat, baseUrl });
  let sessionId: number | null = null;
  try {
    const session = await account.sandbox.createSession("wspbot wapi-check");
    sessionId = session.id;
    check("sandbox session created", typeof session.id === "number", `— id ${session.id}`);
    check(
      "its number is under the unroutable 999 country code",
      session.phone_number.replace(/\D/g, "").startsWith("999"),
      `— ${session.phone_number}`,
    );
    check("it carries its own API key", typeof session.api_key === "string" && session.api_key.length > 0);

    const sandbox = new WapiClient({ apiKey: session.api_key!, baseUrl });

    // It pairs itself a few seconds after connect; `scan` finishes the pairing immediately.
    await account.sessions.connection.connect(session.id);
    await sandbox.sandbox.scan().catch(() => {});

    const sent = await sandbox.messages.send({
      to: session.phone_number,
      text: "wapi-check: proving send through the vendored SDK",
    });
    check("send returns a numeric msgId", typeof sent.msgId === "number", `— ${sent.msgId}`);
    check("send returns the jid it went to", typeof sent.jid === "string", `— ${sent.jid}`);
    check("send returns a status", typeof sent.status === "string", `— ${sent.status}`);

    /**
     * `info` reads back what was sent, and its two fields follow WhatsApp's own record rather
     * than this API's conventions: the timestamp is a string and the status a number.
     */
    const info = await sandbox.messages.info(sent.msgId);
    check("info reads the message back", Boolean(info), `— status ${String(info?.status)}`);
  } finally {
    if (sessionId !== null) {
      await account.sessions
        .delete(sessionId)
        .then(() => console.log(`  cleaned up sandbox session ${sessionId}`))
        .catch((err) =>
          console.error(`  WARNING could not delete sandbox session ${sessionId}:`, err),
        );
    }
  }
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
