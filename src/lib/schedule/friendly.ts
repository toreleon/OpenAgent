/**
 * Client-safe helpers that translate between the cron-backed Schedule model and
 * A Tasks-style natural language: a Frequency picker (Daily / Weekly /
 * Monthly / Custom) that builds cron, a reverse detector for editing, a
 * cron -> "Every weekday at 8:00 AM" renderer, and a relative next-run label.
 *
 * No cron-parser / cronstrue here (those stay server-side); the friendly
 * renderer only recognizes the shapes this UI produces and returns null for
 * anything else so callers can fall back to the server's cronstrue description.
 */

export type Frequency = "daily" | "weekly" | "monthly" | "custom";

/** Frequency options shown in the picker, in order. */
export const FREQUENCIES: { id: Frequency; label: string }[] = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
  { id: "custom", label: "Custom" },
];

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
/** Single-letter labels for the day-of-week chips, Sunday-first. */
export const DAY_CHIPS: { value: number; label: string }[] = [
  { value: 0, label: "S" },
  { value: 1, label: "M" },
  { value: 2, label: "T" },
  { value: 3, label: "W" },
  { value: 4, label: "T" },
  { value: 5, label: "F" },
  { value: 6, label: "S" },
];

function isNum(s: string): boolean {
  return /^\d+$/.test(s);
}

/** Format 24h H:MM as "8:00 AM". */
export function formatTime12(h: number, m: number): string {
  const ampm = h < 12 ? "AM" : "PM";
  let hh = h % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ampm}`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Parse a cron day-of-week field ("1-5", "1,3", "3") into sorted unique 0..6, or null. */
export function parseDow(dow: string): number[] | null {
  if (dow === "*") return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set<number>();
  for (const part of dow.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a > b || b > 6) return null;
      for (let i = a; i <= b; i++) out.add(i);
    } else if (isNum(part) && Number(part) <= 6) {
      out.add(Number(part));
    } else {
      return null;
    }
  }
  return [...out].sort((a, b) => a - b);
}

function sameSet(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Build a 5-field cron from the friendly picker state. */
export function buildScheduleCron(
  freq: Frequency,
  opts: { time?: string; days?: number[]; dayOfMonth?: number },
): string {
  const { h, m } = parseHM(opts.time);
  switch (freq) {
    case "daily":
      return `${m} ${h} * * *`;
    case "weekly": {
      const days = (opts.days && opts.days.length ? opts.days : [1])
        .slice()
        .sort((a, b) => a - b);
      return `${m} ${h} * * ${days.join(",")}`;
    }
    case "monthly": {
      const dom = Math.min(28, Math.max(1, opts.dayOfMonth ?? 1));
      return `${m} ${h} ${dom} * *`;
    }
    default:
      return `${m} ${h} * * *`;
  }
}

function parseHM(time: string | undefined): { h: number; m: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec((time ?? "").trim());
  if (!match) return { h: 9, m: 0 };
  return {
    h: Math.min(23, Math.max(0, parseInt(match[1], 10))),
    m: Math.min(59, Math.max(0, parseInt(match[2], 10))),
  };
}

/** Reverse of {@link buildScheduleCron}: detect the picker state for editing. */
export function detectFrequency(cron: string): {
  frequency: Frequency;
  time: string;
  days: number[];
  dayOfMonth: number;
} {
  const fallback = { frequency: "custom" as Frequency, time: "09:00", days: [1], dayOfMonth: 1 };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return fallback;
  const [min, hour, dom, mon, dow] = parts;
  if (mon !== "*" || !isNum(min) || !isNum(hour)) return fallback;
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  if (dom === "*" && dow === "*") return { ...fallback, frequency: "daily", time };
  if (dom === "*" && dow !== "*") {
    const days = parseDow(dow);
    if (!days || days.length === 0 || days.length === 7) return fallback;
    return { ...fallback, frequency: "weekly", time, days };
  }
  if (isNum(dom) && Number(dom) >= 1 && Number(dom) <= 28 && dow === "*") {
    return { ...fallback, frequency: "monthly", time, dayOfMonth: Number(dom) };
  }
  return fallback;
}

/**
 * Render a cron as natural language ("Every weekday at 8:00 AM"),
 * or null when it isn't one of the recognized shapes (caller falls back to the
 * server's cronstrue description).
 */
export function describeCronFriendly(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;

  if (min === "0" && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return "Every hour";
  }
  if (mon !== "*" || !isNum(min) || !isNum(hour)) return null;
  const time = formatTime12(Number(hour), Number(min));

  if (dom === "*" && dow === "*") return `Every day at ${time}`;

  if (dom === "*" && dow !== "*") {
    const days = parseDow(dow);
    if (!days || days.length === 0) return null;
    if (days.length === 7) return `Every day at ${time}`;
    if (sameSet(days, [1, 2, 3, 4, 5])) return `Every weekday at ${time}`;
    if (sameSet(days, [0, 6])) return `Every weekend at ${time}`;
    if (days.length === 1) return `Every ${DAY_NAMES[days[0]]} at ${time}`;
    return `Every ${joinAnd(days.map((d) => DAY_NAMES[d]))} at ${time}`;
  }

  if (isNum(dom) && dow === "*") {
    return `Monthly on the ${ordinal(Number(dom))} at ${time}`;
  }
  return null;
}

/** A short relative label for the next run: "in 40m" · "in 16h" · "tomorrow, 8:00 AM" · "Mon, 8:00 AM". */
export function nextRunLabel(iso: string, timezone: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = then - Date.now();
  if (diff <= 0) return "due now";
  const MIN = 60_000, HR = 3_600_000, DAY = 86_400_000;
  if (diff < HR) return `in ${Math.max(1, Math.round(diff / MIN))}m`;
  if (diff < DAY) return `in ${Math.round(diff / HR)}h`;

  let time: string;
  try {
    time = new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(then));
  } catch {
    time = formatTime12(new Date(then).getHours(), new Date(then).getMinutes());
  }

  const startOfDay = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const daysAway = Math.round((startOfDay(then) - startOfDay(Date.now())) / DAY);
  if (daysAway <= 1) return `tomorrow, ${time}`;
  if (daysAway < 7) {
    const wd = new Date(then).toLocaleDateString(undefined, { weekday: "short" });
    return `${wd}, ${time}`;
  }
  const date = new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${date}, ${time}`;
}
