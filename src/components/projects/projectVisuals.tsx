"use client";

import { Folder } from "lucide-react";
import { cn } from "@/components/ui/cn";

/**
 * ChatGPT projects show a small rounded-square folder glyph in a per-project
 * accent color. We have no color column, so derive a stable accent from the
 * project id — deterministic, so a project always looks the same.
 */
const PROJECT_COLORS = [
  "#7A63D1", // violet
  "#2F86B4", // blue
  "#3F9D6B", // green
  "#C1662B", // orange
  "#BC4B78", // pink
  "#4E74B8", // indigo
  "#9A7B2E", // gold
  "#5B616E", // slate
];

export function projectColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PROJECT_COLORS[h % PROJECT_COLORS.length];
}

/** The accent-colored rounded-square folder badge used across the projects UI. */
export function ProjectGlyph({
  id,
  size = 32,
  radius = 10,
  className,
}: {
  id: string;
  size?: number;
  radius?: number;
  className?: string;
}) {
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center text-white", className)}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: projectColor(id),
      }}
      aria-hidden="true"
    >
      <Folder size={Math.round(size * 0.52)} className="fill-white/25" />
    </span>
  );
}

/** ChatGPT-style short relative time: "Just now" · "12m" · "5h" · "Yesterday" · "Mon" · "Mar 12". */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const MIN = 60_000, HR = 3_600_000, DAY = 86_400_000;
  if (diff < MIN) return "Just now";
  if (diff < HR) return `${Math.floor(diff / MIN)}m`;
  if (diff < DAY) return `${Math.floor(diff / HR)}h`;

  const d = new Date(then);
  const n = new Date(now);
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const daysAgo = Math.round((startOfDay(n) - startOfDay(d)) / DAY);
  if (daysAgo <= 1) return "Yesterday";
  if (daysAgo < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  const sameYear = d.getFullYear() === n.getFullYear();
  return d.toLocaleDateString(
    undefined,
    sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
}
