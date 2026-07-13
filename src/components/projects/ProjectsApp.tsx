"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FolderKanban,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { ProjectSummary } from "@/lib/types";
import { useProjectStore } from "@/store/projects";
import { useChatStore } from "@/store/chat";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { cn } from "@/components/ui/cn";
import { ProjectForm } from "./ProjectForm";
import { ProjectIcon, relativeTime } from "./projectVisuals";

/** Projects overview: a clean list of the user's projects. */
export function ProjectsApp() {
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectSummary | null>(null);

  const projects = useProjectStore((s) => s.projects);
  const loading = useProjectStore((s) => s.loading);
  const error = useProjectStore((s) => s.error);
  const load = useProjectStore((s) => s.load);
  const remove = useProjectStore((s) => s.remove);
  const clearError = useProjectStore((s) => s.clearError);

  const loadConversations = useChatStore((s) => s.loadConversations);

  useEffect(() => {
    void load();
    void loadConversations();
  }, [load, loadConversations]);

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  async function handleDelete(p: ProjectSummary) {
    const confirmed = window.confirm(
      `Delete “${p.name}”? This permanently deletes the project along with its ` +
        `${p.conversationCount} chat${p.conversationCount === 1 ? "" : "s"} and files. This can’t be undone.`,
    );
    if (confirmed) void remove(p.id);
  }

  const isEmpty = projects.length === 0;

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
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 px-4">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between">
            <h1 className="text-lg font-semibold text-text-primary">Projects</h1>
            <Button size="sm" onClick={openCreate}>
              <Plus size={16} /> New project
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
          <div className="mx-auto w-full max-w-3xl px-4 py-4">
            {loading && isEmpty ? (
              <div className="flex items-center justify-center py-20 text-text-secondary">
                <Spinner size={22} />
              </div>
            ) : isEmpty ? (
              <EmptyState onCreate={openCreate} />
            ) : (
              <ul className="flex flex-col">
                {projects.map((p) => (
                  <li
                    key={p.id}
                    className="group relative flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-hover"
                  >
                    <button
                      type="button"
                      onClick={() => router.push(`/projects/${p.id}`)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary">
                        <ProjectIcon icon={p.icon} size={20} />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium text-text-primary">
                          {p.name}
                        </span>
                        <span className="truncate text-xs text-text-secondary">
                          {p.conversationCount} chat
                          {p.conversationCount === 1 ? "" : "s"}
                          {p.fileCount > 0
                            ? ` · ${p.fileCount} file${p.fileCount === 1 ? "" : "s"}`
                            : ""}
                        </span>
                      </span>
                    </button>
                    <span className="shrink-0 text-xs tabular-nums text-text-secondary group-hover:hidden">
                      {relativeTime(p.updatedAt)}
                    </span>
                    <div className="hidden group-hover:block">
                      <Dropdown
                        align="end"
                        menuClassName="min-w-[10rem]"
                        trigger={
                          <span className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-border/50 hover:text-text-primary">
                            <MoreHorizontal size={16} />
                          </span>
                        }
                      >
                        {(close) => (
                          <>
                            <DropdownItem
                              onClick={() => {
                                setEditing(p);
                                setFormOpen(true);
                                close();
                              }}
                            >
                              <Pencil size={15} /> Rename
                            </DropdownItem>
                            <DropdownItem
                              danger
                              onClick={() => {
                                void handleDelete(p);
                                close();
                              }}
                            >
                              <Trash2 size={15} /> Delete
                            </DropdownItem>
                          </>
                        )}
                      </Dropdown>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <ProjectForm
        open={formOpen}
        project={editing}
        onClose={() => setFormOpen(false)}
        onCreated={(id) => router.push(`/projects/${id}`)}
      />
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mt-6 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-hover text-text-secondary">
        <FolderKanban size={24} />
      </span>
      <h2 className="mt-4 text-base font-semibold text-text-primary">
        No projects yet
      </h2>
      <p className="mt-1 max-w-sm text-sm text-text-secondary">
        Projects keep chats, files, and instructions together in one place — so
        every conversation shares the same context.
      </p>
      <Button className="mt-5" size="sm" onClick={onCreate}>
        <Plus size={16} /> New project
      </Button>
    </div>
  );
}

export default ProjectsApp;
