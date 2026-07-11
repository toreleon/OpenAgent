/**
 * Pure, dependency-free helpers for the schedule form. These build and reverse
 * 5-field cron expressions from friendly presets ("Daily at 09:00", "Weekly on
 * Monday", …). They contain NO `cron-parser` / `cronstrue` imports so this module
 * is safe to bundle on the client (the server owns validation + next-run
 * computation via `@/lib/schedule/cron`, exposed through the preview endpoint).
 */

export type PresetId =
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "custom";

/** Describes a preset and which extra inputs the form must collect for it. */
export interface SchedulePreset {
  id: PresetId;
  label: string;
  /** Needs an HH:MM time-of-day input. */
  needsTime: boolean;
  /** Needs a day-of-week input (0=Sunday..6=Saturday). */
  needsWeekday: boolean;
  /** Needs a day-of-month input (1..28). */
  needsDayOfMonth: boolean;
}

/** The presets offered in the form, in display order. */
export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { id: "hourly", label: "Every hour", needsTime: false, needsWeekday: false, needsDayOfMonth: false },
  { id: "daily", label: "Every day", needsTime: true, needsWeekday: false, needsDayOfMonth: false },
  { id: "weekdays", label: "Every weekday (Mon–Fri)", needsTime: true, needsWeekday: false, needsDayOfMonth: false },
  { id: "weekly", label: "Every week", needsTime: true, needsWeekday: true, needsDayOfMonth: false },
  { id: "monthly", label: "Every month", needsTime: true, needsWeekday: false, needsDayOfMonth: true },
  { id: "custom", label: "Custom (cron)", needsTime: false, needsWeekday: false, needsDayOfMonth: false },
];

/** Weekday labels indexed by cron day-of-week (0=Sunday). */
export const WEEKDAYS: { value: number; label: string }[] = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

/** Options that parameterize a preset. */
export interface PresetOptions {
  /** "HH:MM" 24-hour local time; defaults to "09:00". */
  time?: string;
  /** Cron day-of-week 0..6 (0=Sunday); defaults to 1 (Monday). */
  weekday?: number;
  /** Day of month 1..28; defaults to 1. Capped at 28 so it fires every month. */
  day?: number;
}

/** Parse "HH:MM" into {h, m}, clamped to valid ranges; falls back to 09:00. */
function parseTime(time: string | undefined): { h: number; m: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec((time ?? "").trim());
  if (!match) return { h: 9, m: 0 };
  const h = Math.min(23, Math.max(0, parseInt(match[1], 10)));
  const m = Math.min(59, Math.max(0, parseInt(match[2], 10)));
  return { h, m };
}

/**
 * Build a 5-field cron expression from a preset + options. The "custom" preset
 * has no canonical expansion and returns a sensible daily default; the form
 * should let the user type the raw cron instead.
 */
export function buildCron(preset: PresetId, opts: PresetOptions = {}): string {
  const { h, m } = parseTime(opts.time);
  const weekday = opts.weekday ?? 1;
  const day = Math.min(28, Math.max(1, opts.day ?? 1));
  switch (preset) {
    case "hourly":
      // Fire at minute 0 of every hour.
      return "0 * * * *";
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${weekday}`;
    case "monthly":
      return `${m} ${h} ${day} * *`;
    case "custom":
    default:
      return `${m} ${h} * * *`;
  }
}

/**
 * Best-effort reverse of {@link buildCron}: detect which preset a cron matches so
 * the form can pre-select it when editing. Returns `custom` for anything that
 * doesn't match a preset's canonical shape exactly.
 */
export function detectPreset(cron: string): { preset: PresetId } & PresetOptions {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { preset: "custom" };
  const [min, hour, dom, mon, dow] = parts;

  const isNum = (s: string) => /^\d+$/.test(s);
  const time = isNum(min) && isNum(hour)
    ? `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`
    : undefined;

  // Every hour: "0 * * * *"
  if (min === "0" && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { preset: "hourly" };
  }
  if (mon !== "*") return { preset: "custom" };

  // Weekdays: "m h * * 1-5"
  if (isNum(min) && isNum(hour) && dom === "*" && dow === "1-5") {
    return { preset: "weekdays", time };
  }
  // Daily: "m h * * *"
  if (isNum(min) && isNum(hour) && dom === "*" && dow === "*") {
    return { preset: "daily", time };
  }
  // Weekly: "m h * * <0-6>"
  if (isNum(min) && isNum(hour) && dom === "*" && isNum(dow) && Number(dow) <= 6) {
    return { preset: "weekly", time, weekday: Number(dow) };
  }
  // Monthly: "m h <1-28> * *"
  if (isNum(min) && isNum(hour) && isNum(dom) && Number(dom) >= 1 && Number(dom) <= 28 && dow === "*") {
    return { preset: "monthly", time, day: Number(dom) };
  }
  return { preset: "custom" };
}
