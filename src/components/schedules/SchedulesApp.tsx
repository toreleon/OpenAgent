"use client";

import { useEffect, useMemo, useState } from "react";
import { AlarmClock, Plus, X } from "lucide-react";
import type { ScheduleSummary } from "@/lib/types";
import { useScheduleStore } from "@/store/schedules";
import { useChatStore } from "@/store/chat";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { ScheduleRow } from "./ScheduleRow";
import { ScheduleForm, type ScheduleTemplate } from "./ScheduleForm";

type Filter = "all" | "active" | "paused";

const EXAMPLES: { label: string; template: ScheduleTemplate }[] = [
  {
    label: "Daily briefing",
    template: {
      title: "Daily briefing",
      prompt: "Give me a concise briefing of today's top news and my calendar.",
    },
  },
  {
    label: "Weekly report",
    template: {
      title: "Weekly report",
      prompt: "Summarize this week's progress into a short weekly report.",
    },
  },
  {
    label: "Reminder",
    template: {
      title: "Daily reminder",
      prompt: "Remind me to review my top three priorities for the day.",
    },
  },
];

/** Top-level client app for /schedules — a Tasks-style list. */
export function SchedulesApp() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleSummary | null>(null);
  const [template, setTemplate] = useState<ScheduleTemplate | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const schedules = useScheduleStore((s) => s.schedules);
  const loading = useScheduleStore((s) => s.loading);
  const error = useScheduleStore((s) => s.error);
  const load = useScheduleStore((s) => s.load);
  const clearError = useScheduleStore((s) => s.clearError);

  const loadConversations = useChatStore((s) => s.loadConversations);

  useEffect(() => {
    void load();
    void loadConversations();
  }, [load, loadConversations]);

  // Active first, then soonest next-run; paused sink to the bottom.
  const sorted = useMemo(() => {
    return [...schedules].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      const at = a.nextRunAt ? Date.parse(a.nextRunAt) : Infinity;
      const bt = b.nextRunAt ? Date.parse(b.nextRunAt) : Infinity;
      return at - bt;
    });
  }, [schedules]);

  const activeCount = schedules.filter((s) => s.enabled).length;
  const pausedCount = schedules.length - activeCount;

  const visible = useMemo(() => {
    if (filter === "active") return sorted.filter((s) => s.enabled);
    if (filter === "paused") return sorted.filter((s) => !s.enabled);
    return sorted;
  }, [sorted, filter]);

  function openCreate(t: ScheduleTemplate | null = null) {
    setEditing(null);
    setTemplate(t);
    setFormOpen(true);
  }
  function openEdit(schedule: ScheduleSummary) {
    setTemplate(null);
    setEditing(schedule);
    setFormOpen(true);
  }

  const isEmpty = schedules.length === 0;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-main">
      <div
        className={cn(
          "h-full shrink-0 overflow-hidden border-r border-border/60 transition-[width] duration-200",
          sidebarOpen ? "w-[260px]" : "w-[52px]",
        )}
      >
        <Sidebar open={sidebarOpen} onToggle={() => setSidebarOpen((o) => !o)} />
      </div>

      <div className="flex h-full min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center px-4">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between">
            <h1 className="text-lg font-semibold text-text-primary">Scheduled tasks</h1>
            <Button size="sm" onClick={() => openCreate()}>
              <Plus size={16} /> New task
            </Button>
          </div>
        </header>

        {error && (
          <div className="mx-auto mt-1 flex w-full max-w-3xl items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-danger">
            <span className="truncate">{error}</span>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={clearError}
              className="shrink-0 text-danger transition-opacity hover:opacity-80"
            >
              <X size={16} />
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-3">
            {loading && isEmpty ? (
              <div className="flex items-center justify-center py-20 text-text-secondary">
                <Spinner size={22} />
              </div>
            ) : isEmpty ? (
              <EmptyState onCreate={openCreate} />
            ) : (
              <>
                {/* Filter tabs */}
                <div className="mb-1 flex items-center gap-1 border-b border-border/60 pb-1">
                  <FilterTab label="All" count={schedules.length} active={filter === "all"} onClick={() => setFilter("all")} />
                  <FilterTab label="Active" count={activeCount} active={filter === "active"} onClick={() => setFilter("active")} />
                  <FilterTab label="Paused" count={pausedCount} active={filter === "paused"} onClick={() => setFilter("paused")} />
                </div>

                {visible.length === 0 ? (
                  <p className="py-10 text-center text-sm text-text-secondary">
                    {filter === "paused" ? "No paused tasks." : "No active tasks."}
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y divide-border/40">
                    {visible.map((s) => (
                      <ScheduleRow key={s.id} schedule={s} onEdit={openEdit} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <ScheduleForm
        open={formOpen}
        schedule={editing}
        template={template}
        onClose={() => setFormOpen(false)}
      />
    </div>
  );
}

function FilterTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active ? "text-text-primary" : "text-text-secondary hover:text-text-primary",
      )}
    >
      {label}
      <span className="ml-1.5 text-xs text-text-secondary">{count}</span>
      {active && (
        <span className="absolute inset-x-2 -bottom-1 h-0.5 rounded-full bg-text-primary" />
      )}
    </button>
  );
}

function EmptyState({ onCreate }: { onCreate: (t?: ScheduleTemplate | null) => void }) {
  return (
    <div className="mt-6 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 py-14 text-center">
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-hover text-text-secondary">
        <AlarmClock size={24} />
      </span>
      <h2 className="text-base font-semibold text-text-primary">No scheduled tasks yet</h2>
      <p className="mt-1 max-w-sm text-sm text-text-secondary">
        Have the assistant do something on a schedule — like “Every weekday at 8 AM,
        summarize the top AI news” — or create one here.
      </p>
      <Button className="mt-5" size="sm" onClick={() => onCreate()}>
        <Plus size={16} /> Create task
      </Button>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex.label}
            type="button"
            onClick={() => onCreate(ex.template)}
            className="rounded-full border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          >
            {ex.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default SchedulesApp;
