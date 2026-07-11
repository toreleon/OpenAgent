"use client";

import { create } from "zustand";
import type {
  CreateScheduleRequest,
  CronPreviewResponse,
  ScheduleRunSummary,
  ScheduleSummary,
  UpdateScheduleRequest,
} from "@/lib/types";

/** Read an { error } body from a failed Response, falling back to a default. */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    /* non-JSON body */
  }
  return fallback;
}

export interface ScheduleState {
  // ---- data ----
  schedules: ScheduleSummary[];

  // ---- ui / status ----
  loading: boolean;
  /** True while a create/update/delete/run mutation is in flight. */
  saving: boolean;
  error: string | null;

  // ---- actions ----
  load: () => Promise<void>;
  create: (req: CreateScheduleRequest) => Promise<ScheduleSummary | null>;
  update: (
    id: string,
    patch: UpdateScheduleRequest,
  ) => Promise<ScheduleSummary | null>;
  remove: (id: string) => Promise<void>;
  runNow: (id: string) => Promise<ScheduleRunSummary | null>;
  /** Fetch a live cron preview (never throws; returns an invalid result on error). */
  preview: (cron: string, tz: string) => Promise<CronPreviewResponse>;
  clearError: () => void;
}

export const useScheduleStore = create<ScheduleState>((set, get) => ({
  schedules: [],
  loading: false,
  saving: false,
  error: null,

  clearError: () => set({ error: null }),

  load: async () => {
    set({ loading: true });
    try {
      const res = await fetch("/api/schedules", { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res, "Failed to load scheduled tasks"));
      const data = (await res.json()) as ScheduleSummary[];
      set({ schedules: data, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to load scheduled tasks" });
    } finally {
      set({ loading: false });
    }
  },

  create: async (req) => {
    set({ saving: true, error: null });
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(await readError(res, "Failed to create scheduled task"));
      const created = (await res.json()) as ScheduleSummary;
      // Refetch so ordering + derived fields (nextRunAt, description) are canonical.
      await get().load();
      return created;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to create scheduled task" });
      return null;
    } finally {
      set({ saving: false });
    }
  },

  update: async (id, patch) => {
    // Optimistic merge so toggles feel instant; revert + surface on failure.
    const prev = get().schedules;
    set({
      saving: true,
      error: null,
      schedules: prev.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
    try {
      const res = await fetch(`/api/schedules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await readError(res, "Failed to update scheduled task"));
      const updated = (await res.json()) as ScheduleSummary;
      // Refetch to pick up recomputed nextRunAt / description.
      await get().load();
      return updated;
    } catch (e) {
      set({
        schedules: prev,
        error: e instanceof Error ? e.message : "Failed to update scheduled task",
      });
      return null;
    } finally {
      set({ saving: false });
    }
  },

  remove: async (id) => {
    const prev = get().schedules;
    set({ saving: true, error: null, schedules: prev.filter((s) => s.id !== id) });
    try {
      const res = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, "Failed to delete scheduled task"));
      // Refetch to stay in sync with the server (cascade of runs, etc.).
      await get().load();
    } catch (e) {
      set({
        schedules: prev,
        error: e instanceof Error ? e.message : "Failed to delete scheduled task",
      });
    } finally {
      set({ saving: false });
    }
  },

  runNow: async (id) => {
    set({ saving: true, error: null });
    try {
      const res = await fetch(`/api/schedules/${id}/run`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res, "Failed to run task"));
      const run = (await res.json()) as ScheduleRunSummary;
      // Refetch so the row's lastRun / status chip reflects this run.
      await get().load();
      return run;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to run task" });
      return null;
    } finally {
      set({ saving: false });
    }
  },

  preview: async (cron, tz) => {
    try {
      const params = new URLSearchParams({ cron, tz });
      const res = await fetch(`/api/schedules/preview?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        return {
          valid: false,
          description: "",
          nextRuns: [],
          error: await readError(res, "Invalid schedule"),
        };
      }
      return (await res.json()) as CronPreviewResponse;
    } catch (e) {
      return {
        valid: false,
        description: "",
        nextRuns: [],
        error: e instanceof Error ? e.message : "Preview failed",
      };
    }
  },
}));
