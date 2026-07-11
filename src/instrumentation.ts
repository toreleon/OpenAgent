/**
 * Next.js instrumentation hook (enabled via experimental.instrumentationHook in
 * next.config.js). Runs once when the server process boots. We use it to start
 * the in-process scheduler ticker — but only on the Node.js runtime and only when
 * explicitly enabled, so the Edge runtime and build steps never spin it up.
 */
export async function register(): Promise<void> {
  // IMPORTANT: gate the node-only dynamic import with a POSITIVE
  // `process.env.NEXT_RUNTIME === "nodejs"` block. Next.js uses exactly this
  // pattern to prune the import from the Edge instrumentation bundle; an inverted
  // early-return guard does NOT prune it, so webpack would try to bundle the
  // ticker → runner → agent → mcp/oauth (node:crypto) chain for Edge and fail with
  // an UnhandledSchemeError that poisons the whole server. Keep the runtime check
  // as the outer positive conditional.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Opt-in: keep the ticker off by default (serverless deploys drive schedules
    // via /api/cron instead). Checked inside the nodejs block so the import stays
    // node-only.
    if (process.env.SCHEDULER_ENABLED !== "1") return;
    const { startScheduler } = await import("@/lib/schedule/ticker");
    startScheduler();
  }
}
