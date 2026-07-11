"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import {
  Boxes,
  CalendarClock,
  Check,
  LogOut,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  PenSquare,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import type { ConversationSummary } from "@/lib/types";
import { useChatStore } from "@/store/chat";
import { IconButton } from "@/components/ui/IconButton";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { SettingsModal } from "@/components/settings/SettingsModal";
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

  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, query]);

  const groups = useMemo(() => groupConversations(filtered), [filtered]);

  function openConversation(id: string) {
    router.push(`/c/${id}`);
  }

  function handleNewChat() {
    newChat();
    router.push("/");
  }

  const schedulesActive = pathname === "/schedules";
  const artifactsActive = pathname === "/artifacts";

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
            label="Artifacts"
            active={artifactsActive}
            onClick={() => router.push("/artifacts")}
          >
            <Boxes size={20} />
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
        <IconButton label="New chat" onClick={handleNewChat}>
          <PenSquare size={20} />
        </IconButton>
      </div>

      {/* Scheduled nav */}
      <div className="flex flex-col gap-0.5 px-2.5">
        <button
          type="button"
          onClick={() => router.push("/schedules")}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm font-medium transition-colors",
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
            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm font-medium transition-colors",
            artifactsActive
              ? "bg-hover text-text-primary"
              : "text-text-primary hover:bg-hover",
          )}
        >
          <Boxes size={18} />
          Artifacts
        </button>
      </div>

      {/* Search */}
      <div className="px-2.5 pb-2 pt-1">
        <div className="flex items-center gap-2 rounded-lg bg-hover/60 px-2.5 py-2">
          <Search size={16} className="text-text-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
      </div>

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
              <ul className="flex flex-col gap-0.5">
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
    </div>
  );
}

export default Sidebar;
