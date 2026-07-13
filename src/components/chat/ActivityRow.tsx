"use client";

import {
  AlertTriangle,
  Braces,
  Clock,
  FilePlus,
  FileText,
  FolderOpen,
  Globe,
  Loader2,
  PenLine,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { TraceItem } from "@/lib/types";
import { toolActivityIcon, toolActivityLabel } from "@/lib/toolActivity";
import { cn } from "@/components/ui/cn";

type ToolItem = Extract<TraceItem, { type: "tool" }>;

const ICONS: Record<ReturnType<typeof toolActivityIcon>, LucideIcon> = {
  web: Globe,
  page: FileText,
  code: Braces,
  terminal: Terminal,
  file: FileText,
  edit: PenLine,
  "new-file": FilePlus,
  folder: FolderOpen,
  search: Search,
  clock: Clock,
  skill: Sparkles,
  tool: Wrench,
};

/**
 * One tool-activity row inside the Thinking trace: a small icon +
 * a friendly, human label ("Searched the web for …"), never the internal tool
 * name or raw JSON. A spinner marks a call still running; on completion the
 * tool's own icon returns and the label flips to past tense (no green check —
 * done-ness is conveyed by the wording).
 */
export function ActivityRow({ item }: { item: ToolItem }) {
  const label = toolActivityLabel(item.tool, item.arg, item.status);
  const ToolIcon = ICONS[toolActivityIcon(item.tool)] ?? Wrench;
  const running = item.status === "running";
  const error = item.status === "error";

  return (
    <div className="flex items-center gap-2 py-0.5 text-[13px] leading-relaxed text-text-secondary">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {running ? (
          <Loader2 size={13} className="animate-spin opacity-80" />
        ) : error ? (
          <AlertTriangle size={13} className="text-red-400" />
        ) : (
          <ToolIcon size={13} className="opacity-70" />
        )}
      </span>
      <span
        className={cn("min-w-0 truncate", error && "text-red-400/90")}
        title={label}
      >
        {label}
      </span>
    </div>
  );
}

export default ActivityRow;
