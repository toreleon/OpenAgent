/**
 * Server-side cron utilities for scheduled tasks. Wraps `cron-parser` (timezone-
 * aware next-run computation) and `cronstrue` (plain-English descriptions).
 *
 * SERVER-ONLY: `cron-parser` reaches for Node built-ins and must not be bundled
 * into client code. The form gets descriptions + next-run previews from the
 * server via GET /api/schedules/preview instead of importing this module.
 */
import parser from "cron-parser";
import cronstrue from "cronstrue";

/** Default IANA time zone when a schedule doesn't specify one. */
export const DEFAULT_TIMEZONE = "UTC";

/** How many upcoming fire times the preview endpoint returns by default. */
export const PREVIEW_RUN_COUNT = 3;

export interface CronValidation {
  valid: boolean;
  /** Present when valid: the plain-English description. */
  description?: string;
  /** Present when invalid: a short human-readable reason. */
  error?: string;
}

/** True if `tz` is a time zone the runtime's Intl implementation accepts. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    // Throws RangeError for unknown zones.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a candidate time zone to a valid IANA name, falling back to UTC.
 */
export function normalizeTimeZone(tz: string | null | undefined): string {
  const candidate = (tz ?? "").trim();
  return candidate && isValidTimeZone(candidate) ? candidate : DEFAULT_TIMEZONE;
}

/**
 * Plain-English description of a cron expression (cronstrue). Returns a safe
 * fallback string rather than throwing on malformed input.
 */
export function describeCron(expr: string): string {
  try {
    return cronstrue.toString(expr.trim(), { verbose: false, use24HourTimeFormat: true });
  } catch {
    return "Invalid schedule";
  }
}

/**
 * Validate a 5-field cron expression. We require exactly five whitespace-
 * separated fields (minute hour day-of-month month day-of-week) to avoid
 * accepting cron-parser's optional 6-field seconds form, which our UI and
 * next-run cadence don't model.
 */
export function validateCron(expr: string): CronValidation {
  const trimmed = (expr ?? "").trim();
  if (!trimmed) return { valid: false, error: "Schedule is required" };
  if (trimmed.split(/\s+/).length !== 5) {
    return { valid: false, error: "Expected 5 fields: minute hour day month weekday" };
  }
  try {
    parser.parseExpression(trimmed);
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Invalid cron expression",
    };
  }
  return { valid: true, description: describeCron(trimmed) };
}

/**
 * Compute the next fire time strictly AFTER `from` (default: now), evaluated in
 * `timezone`. Returns null when the expression is invalid. The returned Date is
 * an absolute instant (store its UTC value).
 */
export function computeNextRun(
  expr: string,
  timezone: string,
  from: Date = new Date(),
): Date | null {
  const trimmed = (expr ?? "").trim();
  if (!validateCron(trimmed).valid) return null;
  try {
    const interval = parser.parseExpression(trimmed, {
      tz: normalizeTimeZone(timezone),
      currentDate: from,
    });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/**
 * Return up to `count` upcoming fire times after `from`, evaluated in `timezone`.
 * Empty array when the expression is invalid.
 */
export function nextRuns(
  expr: string,
  timezone: string,
  count: number = PREVIEW_RUN_COUNT,
  from: Date = new Date(),
): Date[] {
  const trimmed = (expr ?? "").trim();
  if (!validateCron(trimmed).valid) return [];
  const out: Date[] = [];
  try {
    const interval = parser.parseExpression(trimmed, {
      tz: normalizeTimeZone(timezone),
      currentDate: from,
    });
    for (let i = 0; i < Math.max(0, count); i++) {
      out.push(interval.next().toDate());
    }
  } catch {
    return [];
  }
  return out;
}
