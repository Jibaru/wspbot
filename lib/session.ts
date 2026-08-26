import "server-only";
import { config } from "./config";
import { wapi } from "./wapi";
import { prune } from "./rate-limit";

/**
 * Keeping the WhatsApp session connected.
 *
 * The session drops on its own — most often when the wapi stack it lives in restarts, which
 * takes the WhatsApp socket down with it. Until it is reconnected the bot is silently deaf: the
 * app is up, the webhook is registered, and nothing arrives.
 *
 * Two triggers, because neither is sufficient alone:
 *
 * - the `session.status` webhook, which is immediate but only arrives if wapi is alive to send
 *   it — precisely not the case when wapi is the thing that restarted;
 * - a periodic check, which catches everything else, including the restart case, at the cost of
 *   noticing a little later.
 *
 * Reconnecting needs the Personal Access Token, since `connect` is a session-admin route. With
 * no PAT configured this degrades to logging: the bot still works, it just will not heal itself.
 */

/** Long enough to let a genuine reconnect settle, short enough that nobody notices the gap. */
const CHECK_INTERVAL_MS = 2 * 60 * 1000;

/** A reconnect takes a moment to take effect; retrying inside this window achieves nothing. */
const MIN_ATTEMPT_GAP_MS = 60 * 1000;

/**
 * After this many consecutive failures, stop trying and say so once. The usual cause is a
 * session that needs its QR scanned again, which no amount of retrying will fix.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

type State = { lastAttempt: number; failures: number; quiet: boolean };

/** On `globalThis` so a dev hot-reload does not reset the backoff or start a second watchdog. */
const g = globalThis as unknown as { wspbotSession?: State; wspbotWatchdog?: NodeJS.Timeout };
const state = (): State => (g.wspbotSession ??= { lastAttempt: 0, failures: 0, quiet: false });

/**
 * Reconnect if the session is down.
 *
 * Always re-checks `GET /api/status` first rather than trusting whatever prompted the call: the
 * webhook payload is undocumented, and a stale "disconnected" would otherwise reconnect a
 * perfectly healthy session.
 */
export const ensureConnected = async (reason: string): Promise<boolean> => {
  const s = state();

  let status: string;
  try {
    status = await wapi.status();
  } catch (err) {
    console.warn("[session] could not read status:", err instanceof Error ? err.message : err);
    return false;
  }

  if (status === "connected") {
    if (s.failures > 0) console.log("[session] connected again");
    s.failures = 0;
    s.quiet = false;
    return true;
  }

  const sessionId = config.sessionId();
  const pat = config.wapiPatOptional();
  if (!sessionId || !pat) {
    if (!s.quiet) {
      console.warn(
        `[session] ${status} (${reason}) — cannot reconnect without WAPI_PAT and WAPI_SESSION_ID`,
      );
      s.quiet = true;
    }
    return false;
  }

  const now = Date.now();
  if (now - s.lastAttempt < MIN_ATTEMPT_GAP_MS) return false;
  if (s.failures >= MAX_CONSECUTIVE_FAILURES) {
    if (!s.quiet) {
      console.error(
        `[session] still ${status} after ${s.failures} attempts — it probably needs its QR scanned again`,
      );
      s.quiet = true;
    }
    return false;
  }

  s.lastAttempt = now;
  console.log(`[session] ${status} (${reason}) — reconnecting`);

  try {
    const result = await wapi.connect(sessionId);
    // `connect` answers in SCREAMING_CASE while `/api/status` is lowercase.
    if (result.status.toLowerCase() === "connected") {
      console.log("[session] reconnected");
      s.failures = 0;
      s.quiet = false;
      return true;
    }
    // NEED_SCAN and friends: the credentials are gone, and retrying will not bring them back.
    s.failures++;
    console.warn(`[session] reconnect returned ${result.status}`);
    return false;
  } catch (err) {
    s.failures++;
    console.error("[session] reconnect failed:", err instanceof Error ? err.message : err);
    return false;
  }
};

/**
 * The periodic check. Started once from `instrumentation.ts`, which runs when the server boots
 * — this is a long-lived container, not a serverless function, so an interval is a real thing
 * here and not a trick.
 */
export const startWatchdog = (): void => {
  if (g.wspbotWatchdog) return;

  console.log(
    `[session] watchdog every ${CHECK_INTERVAL_MS / 1000}s${
      config.wapiPatOptional() && config.sessionId() ? "" : " (read-only: no PAT configured)"
    }`,
  );

  const timer = setInterval(() => {
    void ensureConnected("periodic check");
    // Piggy-backed on an existing tick rather than given a timer of its own.
    void prune();
  }, CHECK_INTERVAL_MS);

  // Never hold the process open on our account.
  timer.unref?.();
  g.wspbotWatchdog = timer;

  // One check at boot, since a restart is exactly when the session tends to be down.
  void ensureConnected("startup");
};
