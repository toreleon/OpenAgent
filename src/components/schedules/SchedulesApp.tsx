"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Plus, X } from "lucide-react";
import type { ScheduleSummary } from "@/lib/types";
import { useScheduleStore } from "@/store/schedules";
import { useChatStore } from "@/store/chat";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { ScheduleRow } from "./ScheduleRow";
import { ScheduleForm } from "./ScheduleForm";

/**
 * Top-level client app for the /schedules route. Mirrors the ChatApp shell
 * (collapsible sidebar + content column) so navigation between chats and
 * scheduled tasks feels seamless, then renders the schedule list, empty state,
 * error banner, and the create/edit modal.
 */
export function SchedulesApp() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleSummary | null>(null);

  const schedules = useScheduleStore((s) => s.schedules);
  const loading = useScheduleStore((s) => s.loading);
  const error = useScheduleStore((s) => s.error);
  const load = useScheduleStore((s) => s.load);
  const clearError = useScheduleStore((s) => s.clearError);

  // The shared Sidebar reads the conversation list from the chat store; load it
  // here too so the left rail is populated when landing directly on /schedules.
  const loadConversations = useChatStore((s) => s.loadConversations);

  useEffect(() => {
    void load();
    void loadConversations();
  }, [load, loadConversations]);

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(schedule: ScheduleSummary) {
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
        {/* Top bar */}
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <CalendarClock size={18} className="text-text-secondary" />
            Scheduled tasks
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus size={16} /> New task
          </Button>
        </header>

        {error && (
          <div className="mx-auto mt-1 flex w-full max-w-3xl items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            <span className="truncate">{error}</span>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={clearError}
              className="shrink-0 text-red-300 hover:text-red-200"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Main area */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-6">
            {loading && isEmpty ? (
              <div className="flex items-center justify-center py-20 text-text-secondary">
                <Spinner size={22} />
              </div>
            ) : isEmpty ? (
              <EmptyState onCreate={openCreate} />
            ) : (
              <div className="flex flex-col gap-3">
                {schedules.map((s) => (
                  <ScheduleRow key={s.id} schedule={s} onEdit={openEdit} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <ScheduleForm
        open={formOpen}
        schedule={editing}
        onClose={() => setFormOpen(false)}
      />
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 py-16 text-center">
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-hover text-text-secondary">
        <CalendarClock size={24} />
      </span>
      <h2 className="text-base font-semibold text-text-primary">
        No scheduled tasks yet
      </h2>
      <p className="mt-1 max-w-sm text-sm text-text-secondary">
        Automate recurring work — a daily briefing, a weekly summary, an hourly
        check. Each run starts a fresh conversation with your prompt.
      </p>
      <Button className="mt-5" size="sm" onClick={onCreate}>
        <Plus size={16} /> New task
      </Button>
    </div>
  );
}

export default SchedulesApp;
