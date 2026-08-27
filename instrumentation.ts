/**
 * Runs once when the server starts.
 *
 * This app is a long-lived container rather than a serverless function, so a background timer
 * is a real thing here — which is what makes the session watchdog possible without any external
 * scheduler.
 */
export async function register() {
  // Also invoked for the edge runtime, where node APIs and pg are unavailable.
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;

  const { startWatchdog } = await import("./lib/session");
  startWatchdog();

  const { startReminders } = await import("./lib/reminder-runner");
  startReminders();
}
