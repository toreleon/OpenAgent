/**
 * The in-process 60s scheduler ticker. Boots from src/instrumentation.ts (only
 * when SCHEDULER_ENABLED=1 on the Node.js runtime) and drives the same
 * runDueSchedules() funnel the external /api/cron endpoint uses.
 *
 * SERVER-ONLY.
 */
import { runDueSchedules, reconcileStuckRuns } from "./runner";

/** Steady-state tick cadence. */
const TICK_INTERVAL_MS = 60_000;
/** Delay before the single warm-up tick fires after boot. */
const WARMUP_DELAY_MS = 5_000;

interface SchedulerGlobal {
  __scheduleTickerStarted?: boolean;
  __scheduleTickerInterval?: ReturnType<typeof setInterval>;
}

// Guard + interval handle live on globalThis so Next.js HMR (which re-evaluates
// this module) can't stack multiple intervals.
const g = globalThis as unknown as SchedulerGlobal;

/**
 * Start the in-process scheduler ticker. Idempotent: a globalThis guard makes
 * repeated calls and HMR reloads no-ops after the first start. Each tick fires
 * due schedules fire-and-forget (wait:false) so the interval callback returns
 * promptly, and a single warm-up tick runs ~5s after boot to catch anything due
 * at startup.
 */
export function startScheduler(): void {
  if (g.__scheduleTickerStarted) return;
  g.__scheduleTickerStarted = true;

  // One-time sweep of runs orphaned in "running" by a prior crash/restart, so
  // the run history never shows a perpetual spinner after this process boots.
  reconcileStuckRuns().catch((err) => {
    console.error("[scheduler] startup reconcile failed:", err);
  });

  const tick = () => {
    runDueSchedules({ wait: false }).catch((err) => {
      console.error("[scheduler] ticker tick failed:", err);
    });
  };

  // Warm-up tick shortly after boot, then the steady 60s cadence.
  setTimeout(tick, WARMUP_DELAY_MS);
  const interval = setInterval(tick, TICK_INTERVAL_MS);
  // Don't keep the Node process alive solely for the ticker.
  if (typeof interval.unref === "function") interval.unref();
  g.__scheduleTickerInterval = interval;
}
