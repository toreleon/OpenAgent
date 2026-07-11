"use client";

import { create } from "zustand";
import type {
  InstallPluginRequest,
  InstallPluginResponse,
  PluginDTO,
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

export interface PluginState {
  plugins: PluginDTO[];
  loading: boolean;
  installing: boolean;
  error: string | null;
  /** Non-fatal notes from the most recent install (skipped sources, etc.). */
  warnings: string[];

  load: () => Promise<void>;
  install: (req: InstallPluginRequest) => Promise<InstallPluginResponse | null>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  setSkillEnabled: (id: string, skill: string, enabled: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clearError: () => void;
  clearWarnings: () => void;
}

export const usePluginStore = create<PluginState>((set, get) => ({
  plugins: [],
  loading: false,
  installing: false,
  error: null,
  warnings: [],

  clearError: () => set({ error: null }),
  clearWarnings: () => set({ warnings: [] }),

  load: async () => {
    set({ loading: true });
    try {
      const res = await fetch("/api/plugins", { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res, "Failed to load plugins"));
      const data = (await res.json()) as PluginDTO[];
      set({ plugins: data, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to load plugins" });
    } finally {
      set({ loading: false });
    }
  },

  install: async (req) => {
    set({ installing: true, error: null, warnings: [] });
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(await readError(res, "Failed to install plugin"));
      const data = (await res.json()) as InstallPluginResponse;
      // Prepend the newly-installed plugins (newest first, matching the API).
      set((s) => ({
        plugins: [...data.plugins, ...s.plugins],
        warnings: data.warnings ?? [],
      }));
      return data;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to install plugin" });
      return null;
    } finally {
      set({ installing: false });
    }
  },

  setEnabled: async (id, enabled) => {
    const prev = get().plugins;
    set({ plugins: prev.map((p) => (p.id === id ? { ...p, enabled } : p)) });
    try {
      const res = await fetch(`/api/plugins/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(await readError(res, "Update failed"));
      const updated = (await res.json()) as PluginDTO;
      set((s) => ({ plugins: s.plugins.map((p) => (p.id === id ? updated : p)) }));
    } catch (e) {
      set({ plugins: prev, error: e instanceof Error ? e.message : "Update failed" });
    }
  },

  setSkillEnabled: async (id, skill, enabled) => {
    const prev = get().plugins;
    // Optimistic per-skill toggle.
    set({
      plugins: prev.map((p) =>
        p.id === id
          ? {
              ...p,
              skills: p.skills.map((s) =>
                s.name === skill ? { ...s, enabled } : s,
              ),
            }
          : p,
      ),
    });
    try {
      const res = await fetch(
        `/api/plugins/${id}/skills/${encodeURIComponent(skill)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      );
      if (!res.ok) throw new Error(await readError(res, "Update failed"));
      const updated = (await res.json()) as PluginDTO;
      set((s) => ({ plugins: s.plugins.map((p) => (p.id === id ? updated : p)) }));
    } catch (e) {
      set({ plugins: prev, error: e instanceof Error ? e.message : "Update failed" });
    }
  },

  remove: async (id) => {
    const prev = get().plugins;
    set({ plugins: prev.filter((p) => p.id !== id) });
    try {
      const res = await fetch(`/api/plugins/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, "Uninstall failed"));
    } catch (e) {
      set({ plugins: prev, error: e instanceof Error ? e.message : "Uninstall failed" });
    }
  },
}));
