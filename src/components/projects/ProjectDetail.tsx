"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  FileText,
  MoreHorizontal,
  Pencil,
  Settings2,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import type { Attachment, ConversationSummary } from "@/lib/types";
import { useProjectStore } from "@/store/projects";
import { useChatStore } from "@/store/chat";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Spinner } from "@/components/ui/Spinner";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { cn } from "@/components/ui/cn";
import Composer from "@/components/chat/Composer";
import { ProjectIcon, relativeTime } from "./projectVisuals";
import { ProjectForm } from "./ProjectForm";
import { ProjectInstructionsModal } from "./ProjectInstructionsModal";
import { ProjectFilesModal } from "./ProjectFilesModal";

export interface ProjectDetailProps {
  projectId: string;
}

/** Project home: chat-first, centered column. */
export function ProjectDetail({ projectId }: ProjectDetailProps) {
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const detail = useProjectStore((s) => s.detail);
  const detailLoading = useProjectStore((s) => s.detailLoading);
  const error = useProjectStore((s) => s.error);
  const loadDetail = useProjectStore((s) => s.loadDetail);
  const remove = useProjectStore((s) => s.remove);
  const clearError = useProjectStore((s) => s.clearError);

  const loadConversations = useChatStore((s) => s.loadConversations);
  const model = useChatStore((s) => s.model);
  const setModel = useChatStore((s) => s.setModel);
  const startProjectChat = useChatStore((s) => s.startProjectChat);

  const [renameOpen, setRenameOpen] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    void loadDetail(projectId);
    void loadConversations();
  }, [projectId, loadDetail, loadConversations]);

  async function handleStartChat(text: string, attachments: Attachment[]) {
    if (starting) return;
    setStarting(true);
    const id = await startProjectChat(projectId, text, attachments);
    if (id) router.push(`/c/${id}`);
    else setStarting(false);
  }

  async function handleDelete() {
    if (!detail) return;
    const n = detail.conversationCount;
    const confirmed = window.confirm(
      `Delete “${detail.name}”? This permanently deletes the project along with its ` +
        `${n} chat${n === 1 ? "" : "s"} and files. This can’t be undone.`,
    );
    if (!confirmed) return;
    const ok = await remove(projectId);
    if (ok) router.push("/projects");
  }

  const chats = detail?.conversations ?? [];
  const hasInstructions = !!detail?.instructions?.trim();
  const fileCount = detail?.fileCount ?? 0;

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
        {error && (
          <div className="mx-auto mt-2 flex w-full max-w-3xl items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-danger">
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
          {detailLoading && !detail ? (
            <div className="flex items-center justify-center py-24 text-text-secondary">
              <Spinner size={22} />
            </div>
          ) : !detail ? (
            <div className="mx-auto mt-24 max-w-md rounded-2xl border border-dashed border-border/70 p-10 text-center">
              <h2 className="text-base font-semibold text-text-primary">
                Project not found
              </h2>
              <button
                type="button"
                onClick={() => router.push("/projects")}
                className="mt-2 text-sm text-text-secondary underline underline-offset-2 hover:text-text-primary"
              >
                Back to projects
              </button>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-3xl px-4 pb-20 pt-12 sm:pt-16">
              {/* Header */}
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary">
                  <ProjectIcon icon={detail.icon} size={22} />
                </span>
                <h1 className="min-w-0 flex-1 truncate text-2xl font-semibold text-text-primary">
                  {detail.name}
                </h1>
                <Dropdown
                  align="end"
                  menuClassName="min-w-[12rem]"
                  trigger={
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-hover hover:text-text-primary">
                      <MoreHorizontal size={20} />
                    </span>
                  }
                >
                  {(close) => (
                    <>
                      <DropdownItem
                        onClick={() => {
                          setRenameOpen(true);
                          close();
                        }}
                      >
                        <Pencil size={15} /> Rename project
                      </DropdownItem>
                      <DropdownItem
                        onClick={() => {
                          setInstructionsOpen(true);
                          close();
                        }}
                      >
                        <Settings2 size={15} /> Instructions
                      </DropdownItem>
                      <DropdownItem
                        onClick={() => {
                          setFilesOpen(true);
                          close();
                        }}
                      >
                        <FileText size={15} /> Files
                      </DropdownItem>
                      <div className="my-1 h-px bg-border/60" />
                      <DropdownItem
                        danger
                        onClick={() => {
                          void handleDelete();
                          close();
                        }}
                      >
                        <Trash2 size={15} /> Delete project
                      </DropdownItem>
                    </>
                  )}
                </Dropdown>
              </div>

              {/* Composer: start a new chat in this project */}
              <div className="mt-6">
                <Composer
                  onSend={handleStartChat}
                  isStreaming={starting}
                  onStop={() => {}}
                  model={model}
                  onModelChange={setModel}
                  placeholder="New chat in this project"
                  hideDisclaimer
                />
              </div>

              {/* Files / Instructions affordances */}
              <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                <AffordanceButton
                  active={fileCount > 0}
                  onClick={() => setFilesOpen(true)}
                  icon={<FileText size={15} />}
                  label={fileCount > 0 ? `Files · ${fileCount}` : "Add files"}
                />
                <AffordanceButton
                  active={hasInstructions}
                  onClick={() => setInstructionsOpen(true)}
                  icon={<Settings2 size={15} />}
                  label={hasInstructions ? "Instructions · edit" : "Add instructions"}
                />
              </div>

              {/* Chats in this project */}
              <div className="mt-10">
                <h2 className="px-1 pb-1 text-sm font-medium text-text-secondary">
                  Chats
                </h2>
                {chats.length === 0 ? (
                  <p className="px-1 py-6 text-sm text-text-secondary">
                    Chats you start in this project will appear here, and share its
                    instructions and files.
                  </p>
                ) : (
                  <ul className="flex flex-col">
                    {chats.map((c) => (
                      <ProjectChatRow key={c.id} chat={c} />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {detail && (
        <>
          <ProjectForm
            open={renameOpen}
            project={detail}
            onClose={() => setRenameOpen(false)}
          />
          <ProjectInstructionsModal
            open={instructionsOpen}
            projectId={detail.id}
            instructions={detail.instructions}
            onClose={() => setInstructionsOpen(false)}
          />
          <ProjectFilesModal
            open={filesOpen}
            projectId={detail.id}
            files={detail.files}
            onClose={() => setFilesOpen(false)}
          />
        </>
      )}
    </div>
  );
}

function AffordanceButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-colors",
        active
          ? "border-border bg-hover text-text-primary"
          : "border-border text-text-secondary hover:bg-hover hover:text-text-primary",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** One row in the project's chat list, with inline rename + a hover kebab. */
function ProjectChatRow({ chat }: { chat: ConversationSummary }) {
  const router = useRouter();
  const renameConversation = useChatStore((s) => s.renameConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const moveConversationToProject = useChatStore(
    (s) => s.moveConversationToProject,
  );

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(chat.title);

  function commit() {
    const v = value.trim();
    if (v && v !== chat.title) void renameConversation(chat.id, v);
    setEditing(false);
  }

  if (editing) {
    return (
      <li className="flex items-center gap-1 rounded-lg bg-hover px-3 py-2">
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={commit}
          className="min-w-0 flex-1 bg-transparent text-sm text-text-primary focus:outline-none"
        />
        <button
          type="button"
          aria-label="Save"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
          className="text-text-secondary hover:text-text-primary"
        >
          <Check size={15} />
        </button>
      </li>
    );
  }

  return (
    <li className="group relative flex items-center rounded-lg transition-colors hover:bg-hover">
      <button
        type="button"
        onClick={() => router.push(`/c/${chat.id}`)}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left"
        title={chat.title}
      >
        <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
          {chat.title}
        </span>
      </button>
      <span className="shrink-0 pr-1 text-xs tabular-nums text-text-secondary group-hover:hidden">
        {relativeTime(chat.updatedAt)}
      </span>
      <div className="hidden pr-1 group-hover:block">
        <Dropdown
          align="end"
          menuClassName="min-w-[11rem]"
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
                  setValue(chat.title);
                  setEditing(true);
                  close();
                }}
              >
                <Pencil size={15} /> Rename
              </DropdownItem>
              <DropdownItem
                onClick={() => {
                  void moveConversationToProject(chat.id, null);
                  close();
                }}
              >
                <SquarePen size={15} /> Remove from project
              </DropdownItem>
              <DropdownItem
                danger
                onClick={() => {
                  void deleteConversation(chat.id);
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
  );
}

export default ProjectDetail;
