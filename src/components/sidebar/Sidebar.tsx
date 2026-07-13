"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import {
  Boxes,
  CalendarClock,
  Check,
  FolderClosed,
  FolderKanban,
  Globe,
  LogOut,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  PenSquare,
  Plus,
  Search,
  Settings,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import type { ConversationSummary, ProjectSummary } from "@/lib/types";
import { useChatStore } from "@/store/chat";
import { useProjectStore } from "@/store/projects";
import { IconButton } from "@/components/ui/IconButton";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { Modal } from "@/components/ui/Modal";
import { SettingsModal } from "@/components/settings/SettingsModal";
import { ProjectForm } from "@/components/projects/ProjectForm";
import { ProjectIcon } from "@/components/projects/projectVisuals";
import { cn } from "@/components/ui/cn";

interface Group {
  label: string;
  items: ConversationSummary[];
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function groupConversations(list: ConversationSummary[]): Group[] {
  const today = startOfDay(new Date());
  const yesterday = today - 24 * 60 * 60 * 1000;
  const week = today - 7 * 24 * 60 * 60 * 1000;

  const buckets: Record<string, ConversationSummary[]> = {
    Today: [],
    Yesterday: [],
    "Previous 7 Days": [],
    Older: [],
  };

  for (const c of list) {
    const t = startOfDay(new Date(c.updatedAt));
    if (t >= today) buckets.Today.push(c);
    else if (t >= yesterday) buckets.Yesterday.push(c);
    else if (t >= week) buckets["Previous 7 Days"].push(c);
    else buckets.Older.push(c);
  }

  return (["Today", "Yesterday", "Previous 7 Days", "Older"] as const)
    .map((label) => ({ label, items: buckets[label] }))
    .filter((g) => g.items.length > 0);
}

export interface SidebarProps {
  open: boolean;
  onToggle: () => void;
}

export function Sidebar({ open, onToggle }: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = useSession();
  const conversations = useChatStore((s) => s.conversations);
  const currentId = useChatStore((s) => s.currentId);
  const newChat = useChatStore((s) => s.newChat);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const moveConversationToProject = useChatStore(
    (s) => s.moveConversationToProject,
  );

  const projects = useProjectStore((s) => s.projects);
  const loadProjects = useProjectStore((s) => s.load);
  const removeProject = useProjectStore((s) => s.remove);

  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  /** Conversation currently targeted by the "Move to project" dialog. */
  const [moveTarget, setMoveTarget] = useState<ConversationSummary | null>(null);
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectEditing, setProjectEditing] = useState<ProjectSummary | null>(null);

  // The Projects section is populated from the shared project store; load it
  // once so the sidebar shows projects on any page (chat, schedules, …).
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Search (modal) runs over ALL chats; the flat recents list below shows only
  // chats NOT in a project (project chats live nested under their project).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, query]);

  const recentChats = useMemo(
    () => conversations.filter((c) => !c.projectId),
    [conversations],
  );
  const groups = useMemo(() => groupConversations(recentChats), [recentChats]);

  async function handleDeleteProject(p: ProjectSummary) {
    const confirmed = window.confirm(
      `Delete “${p.name}”? This permanently deletes the project along with its ` +
        `${p.conversationCount} chat${p.conversationCount === 1 ? "" : "s"} and files. This can’t be undone.`,
    );
    if (!confirmed) return;
    const ok = await removeProject(p.id);
    if (ok && pathname === `/projects/${p.id}`) router.push("/projects");
  }

  function openConversation(id: string) {
    router.push(`/c/${id}`);
  }

  function handleNewChat() {
    newChat();
    router.push("/");
  }

  const schedulesActive = pathname === "/schedules";
  const artifactsActive = pathname === "/artifacts";
  const sitesActive = pathname === "/sites" || pathname.startsWith("/sites/");
  const projectsActive = pathname === "/projects" || pathname.startsWith("/projects/");

  function beginRename(c: ConversationSummary) {
    setEditingId(c.id);
    setEditValue(c.title);
  }

  function commitRename(id: string) {
    const v = editValue.trim();
    if (v) void renameConversation(id, v);
    setEditingId(null);
    setEditValue("");
  }

  const user = session?.user;
  const displayName = user?.name || user?.email || "User";
  const initial = displayName.charAt(0).toUpperCase();

  if (!open) {
    return (
      <>
        <div className="flex h-full w-full flex-col items-center gap-2 bg-sidebar py-2.5">
          <IconButton label="Open sidebar" onClick={onToggle}>
            <PanelLeft size={20} />
          </IconButton>
          <IconButton label="New chat" onClick={handleNewChat}>
            <PenSquare size={20} />
          </IconButton>
          <IconButton
            label="Projects"
            active={projectsActive}
            onClick={() => router.push("/projects")}
          >
            <FolderKanban size={20} />
          </IconButton>
          <IconButton
            label="Artifacts"
            active={artifactsActive}
            onClick={() => router.push("/artifacts")}
          >
            <Boxes size={20} />
          </IconButton>
          <IconButton
            label="Sites"
            active={sitesActive}
            onClick={() => router.push("/sites")}
          >
            <Globe size={20} />
          </IconButton>
          <IconButton
            label="Scheduled"
            active={schedulesActive}
            onClick={() => router.push("/schedules")}
          >
            <CalendarClock size={20} />
          </IconButton>
        </div>
      </>
    );
  }

  return (
    <div className="flex h-full w-full shrink-0 flex-col bg-sidebar">
      {/* Header */}
      <div className="flex items-center justify-between px-2.5 py-2.5">
        <IconButton label="Close sidebar" onClick={onToggle}>
          <PanelLeft size={20} />
        </IconButton>
        <IconButton label="Search chats" onClick={() => setSearchOpen(true)}>
          <Search size={20} />
        </IconButton>
      </div>

      {/* Primary nav */}
      <div className="flex flex-col gap-0.5 px-2.5">
        <button
          type="button"
          onClick={handleNewChat}
          className="motion-press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-hover"
        >
          <PenSquare size={18} />
          New chat
        </button>
        <button
          type="button"
          onClick={() => router.push("/projects")}
          className={cn(
            "motion-press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm font-medium transition-colors",
            projectsActive
              ? "bg-hover text-text-primary"
              : "text-text-primary hover:bg-hover",
          )}
        >
          <FolderKanban size={18} />
          Projects
        </button>
        <button
          type="button"
          onClick={() => router.push("/schedules")}
          className={cn(
            "motion-press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm font-medium transition-colors",
            schedulesActive
              ? "bg-hover text-text-primary"
              : "text-text-primary hover:bg-hover",
          )}
        >
          <CalendarClock size={18} />
          Scheduled
        </button>
        <button
          type="button"
          onClick={() => router.push("/artifacts")}
          className={cn(
            "motion-press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm font-medium transition-colors",
            artifactsActive
              ? "bg-hover text-text-primary"
              : "text-text-primary hover:bg-hover",
          )}
        >
          <Boxes size={18} />
          Artifacts
        </button>
        <button
          type="button"
          onClick={() => router.push("/sites")}
          className={cn(
            "motion-press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm font-medium transition-colors",
            sitesActive
              ? "bg-hover text-text-primary"
              : "text-text-primary hover:bg-hover",
          )}
        >
          <Globe size={18} />
          Sites
        </button>
      </div>

      {/* Projects open their dedicated workspace, which contains the project's chats. */}
      {projects.length > 0 && (
        <div className="group/section mt-1 flex flex-col gap-0.5 px-2.5">
          <div className="flex items-center justify-between px-2 pb-1 pt-2">
            <span className="text-xs font-medium text-text-secondary">Projects</span>
            <button
              type="button"
              aria-label="New project"
              title="New project"
              onClick={() => {
                setProjectEditing(null);
                setProjectFormOpen(true);
              }}
              className="flex h-5 w-5 items-center justify-center rounded text-text-secondary opacity-0 transition-opacity hover:bg-hover hover:text-text-primary group-hover/section:opacity-100"
            >
              <Plus size={15} />
            </button>
          </div>
          {projects.slice(0, 8).map((p) => (
            <SidebarProjectRow
              key={p.id}
              project={p}
              active={pathname === `/projects/${p.id}`}
              onOpen={() => router.push(`/projects/${p.id}`)}
              onNewChat={() => router.push(`/?project=${p.id}`)}
              onRename={() => {
                setProjectEditing(p);
                setProjectFormOpen(true);
              }}
              onDelete={() => void handleDeleteProject(p)}
            />
          ))}
        </div>
      )}

      {/* Conversation list */}
      <nav className="flex-1 overflow-y-auto px-2.5 pb-2">
        {groups.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-text-secondary">
            {query ? "No matching chats" : "No conversations yet"}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="mb-2">
              <div className="px-2 py-2 text-xs font-medium text-text-secondary">
                {group.label}
              </div>
              <ul className="stagger-children flex flex-col gap-0.5">
                {group.items.map((c) => {
                  const active = c.id === currentId;
                  const editing = editingId === c.id;
                  return (
                    <li key={c.id} className="group relative">
                      {editing ? (
                        <div className="flex items-center gap-1 rounded-lg bg-hover px-2 py-1.5">
                          <input
                            autoFocus
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRename(c.id);
                              if (e.key === "Escape") {
                                setEditingId(null);
                                setEditValue("");
                              }
                            }}
                            className="w-full bg-transparent text-sm text-text-primary focus:outline-none"
                          />
                          <button
                            type="button"
                            aria-label="Save"
                            onClick={() => commitRename(c.id)}
                            className="text-text-secondary hover:text-text-primary"
                          >
                            <Check size={15} />
                          </button>
                        </div>
                      ) : (
                        <div
                          className={cn(
                            "flex items-center rounded-lg transition-colors",
                            active ? "bg-hover" : "hover:bg-hover",
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => openConversation(c.id)}
                            className="flex-1 truncate px-2.5 py-2 text-left text-sm text-text-primary"
                            title={c.title}
                          >
                            {c.title}
                          </button>
                          <div
                            className={cn(
                              "pr-1 transition-opacity",
                              active
                                ? "opacity-100"
                                : "opacity-0 group-hover:opacity-100",
                            )}
                          >
                            <Dropdown
                              align="end"
                              menuClassName="min-w-[10rem]"
                              trigger={
                                <span className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-border/50 hover:text-text-primary">
                                  <MoreHorizontal size={16} />
                                </span>
                              }
                            >
                              {(close) => (
                                <>
                                  <DropdownItem
                                    onClick={() => {
                                      beginRename(c);
                                      close();
                                    }}
                                  >
                                    <Pencil size={15} /> Rename
                                  </DropdownItem>
                                  <DropdownItem
                                    onClick={() => {
                                      setMoveTarget(c);
                                      close();
                                    }}
                                  >
                                    <FolderClosed size={15} /> Move to project
                                  </DropdownItem>
                                  <DropdownItem
                                    danger
                                    onClick={() => {
                                      void deleteConversation(c.id);
                                      close();
                                    }}
                                  >
                                    <Trash2 size={15} /> Delete
                                  </DropdownItem>
                                </>
                              )}
                            </Dropdown>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </nav>

      {/* User menu */}
      <div className="border-t border-border/60 p-2.5">
        <Dropdown
          side="top"
          align="start"
          className="w-full"
          menuClassName="w-[236px]"
          trigger={
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-hover"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-white">
                {initial}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                {displayName}
              </span>
            </button>
          }
        >
          {(close) => (
            <>
              <DropdownItem
                onClick={() => {
                  close();
                  setSettingsOpen(true);
                }}
              >
                <Settings size={15} /> Settings
              </DropdownItem>
              <DropdownItem
                danger
                onClick={() => {
                  close();
                  void signOut({ callbackUrl: "/login" });
                }}
              >
                <LogOut size={15} /> Sign out
              </DropdownItem>
            </>
          )}
        </Dropdown>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <Modal
        open={searchOpen}
        onClose={() => {
          setSearchOpen(false);
          setQuery("");
        }}
        title="Search chats"
        className="max-w-lg"
      >
        <div className="p-3">
          <div className="flex items-center gap-2 rounded-lg bg-hover/60 px-2.5 py-2">
            <Search size={16} className="text-text-secondary" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats"
              className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-secondary focus:outline-none"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="text-text-secondary hover:text-text-primary"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div className="mt-2 max-h-80 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-text-secondary">
                No matching chats
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {filtered.map((conversation) => (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      onClick={() => {
                        openConversation(conversation.id);
                        setSearchOpen(false);
                        setQuery("");
                      }}
                      className="w-full truncate rounded-lg px-3 py-2.5 text-left text-sm text-text-primary transition-colors hover:bg-hover"
                    >
                      {conversation.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Modal>

      <MoveToProjectModal
        conversation={moveTarget}
        projects={projects}
        onClose={() => setMoveTarget(null)}
        onMove={(projectId) => {
          if (moveTarget) void moveConversationToProject(moveTarget.id, projectId);
          setMoveTarget(null);
        }}
      />

      <ProjectForm
        open={projectFormOpen}
        project={projectEditing}
        onClose={() => setProjectFormOpen(false)}
        onCreated={(id) => router.push(`/projects/${id}`)}
      />
    </div>
  );
}

/** One project shortcut in the sidebar. Its workspace shows the project's chats. */
function SidebarProjectRow({
  project,
  active,
  onOpen,
  onNewChat,
  onRename,
  onDelete,
}: {
  project: ProjectSummary;
  active: boolean;
  onOpen: () => void;
  onNewChat: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div>
      <div
        className={cn(
          "group/proj flex items-center rounded-lg transition-colors",
          active ? "bg-hover" : "hover:bg-hover",
        )}
      >
        <button
          type="button"
          onClick={onOpen}
          title={project.name}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 pr-1 text-left"
        >
          <ProjectIcon icon={project.icon} size={16} className="shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
            {project.name}
          </span>
        </button>
        <div className="flex shrink-0 items-center pr-1 opacity-0 transition-opacity group-hover/proj:opacity-100">
          <button
            type="button"
            onClick={onNewChat}
            aria-label="New chat in project"
            title="New chat in project"
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-border/50 hover:text-text-primary"
          >
            <SquarePen size={15} />
          </button>
          <Dropdown
            align="end"
            menuClassName="min-w-[10rem]"
            trigger={
              <span className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-border/50 hover:text-text-primary">
                <MoreHorizontal size={16} />
              </span>
            }
          >
            {(close) => (
              <>
                <DropdownItem
                  onClick={() => {
                    onRename();
                    close();
                  }}
                >
                  <Pencil size={15} /> Rename
                </DropdownItem>
                <DropdownItem
                  danger
                  onClick={() => {
                    onDelete();
                    close();
                  }}
                >
                  <Trash2 size={15} /> Delete
                </DropdownItem>
              </>
            )}
          </Dropdown>
        </div>
      </div>

    </div>
  );
}

/**
 * Modal for moving a conversation into one of the user's projects, or removing
 * it from its current project. The Dropdown primitive has no nested submenu, so
 * project selection lives in this small dialog instead.
 */
function MoveToProjectModal({
  conversation,
  projects,
  onClose,
  onMove,
}: {
  conversation: ConversationSummary | null;
  projects: ProjectSummary[];
  onClose: () => void;
  onMove: (projectId: string | null) => void;
}) {
  const currentProjectId = conversation?.projectId ?? null;
  return (
    <Modal
      open={!!conversation}
      onClose={onClose}
      title="Move to project"
      className="max-w-md"
    >
      <div className="flex flex-col gap-1 p-3">
        <button
          type="button"
          onClick={() => onMove(null)}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-hover",
            currentProjectId === null ? "text-text-primary" : "text-text-secondary",
          )}
        >
          <span className="flex items-center gap-2.5">
            <X size={16} /> No project
          </span>
          {currentProjectId === null && <Check size={16} />}
        </button>

        {projects.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-text-secondary">
            You don&apos;t have any projects yet.
          </p>
        ) : (
          projects.map((p) => {
            const selected = p.id === currentProjectId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onMove(p.id)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-hover",
                  selected ? "text-text-primary" : "text-text-primary",
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <FolderClosed size={16} className="shrink-0 text-text-secondary" />
                  <span className="min-w-0 truncate">{p.name}</span>
                </span>
                {selected && <Check size={16} className="shrink-0" />}
              </button>
            );
          })
        )}
      </div>
    </Modal>
  );
}

export default Sidebar;
