"use client";

import {
  BarChart3,
  BookOpen,
  BriefcaseBusiness,
  Code2,
  FolderClosed,
  GraduationCap,
  Heart,
  Lightbulb,
  Palette,
  Rocket,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ProjectIconName } from "@/lib/types";

export const PROJECT_ICON_OPTIONS: Array<{
  id: ProjectIconName;
  label: string;
}> = [
  { id: "folder", label: "General" },
  { id: "briefcase", label: "Work" },
  { id: "code", label: "Code" },
  { id: "book", label: "Reading" },
  { id: "graduation", label: "Learning" },
  { id: "lightbulb", label: "Ideas" },
  { id: "rocket", label: "Launch" },
  { id: "palette", label: "Design" },
  { id: "chart", label: "Analytics" },
  { id: "heart", label: "Personal" },
];

const PROJECT_ICONS: Record<ProjectIconName, LucideIcon> = {
  folder: FolderClosed,
  briefcase: BriefcaseBusiness,
  code: Code2,
  book: BookOpen,
  graduation: GraduationCap,
  lightbulb: Lightbulb,
  rocket: Rocket,
  palette: Palette,
  chart: BarChart3,
  heart: Heart,
};

/** Render the selected semantic project icon with the app's neutral icon style. */
export function ProjectIcon({
  icon,
  size = 20,
  className,
}: {
  icon: ProjectIconName;
  size?: number;
  className?: string;
}) {
  const Icon = PROJECT_ICONS[icon] ?? FolderClosed;
  return <Icon size={size} className={className} aria-hidden="true" />;
}

/** Short relative time: "Just now" · "12m" · "5h" · "Yesterday" · "Mon" · "Mar 12". */
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
