"use client";

import { create } from "zustand";
import type {
  Artifact,
  ArtifactRef,
  SiteRef,
  ArtifactVersion,
  Attachment,
  ChatMessage,
  ConversationDetail,
  ConversationSummary,
  ResearchPhase,
  ResearchState,
  StreamEvent,
  SubagentState,
  ToolCallRecord,
  TraceItem,
} from "@/lib/types";
import { DEFAULT_MODEL, DEFAULT_EFFORT } from "@/lib/types";
import type { ReasoningEffort } from "@/lib/types";
import { extractToolArg } from "@/lib/toolActivity";
import { parseSSE } from "@/lib/sse";
import { useProjectStore } from "@/store/projects";

/**
 * Client-only augmentation of ChatMessage used while streaming the reasoning
 * summary. `reasoningStreaming` is NOT part of the persisted/contract shape — it
 * is a transient UI flag, so we model it as an optional field layered on top of
 * ChatMessage rather than editing the owned types. The Thinking block reads it
 * to decide between the animated "Thinking…" state and the collapsed pill.
 */
type StreamingChatMessage = ChatMessage & { reasoningStreaming?: boolean };

/** Generate a client-only temporary id (replaced by server ids where relevant). */
function tempId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tmp_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

interface SendOptions {
  /** When set, the message is sent into this existing conversation. */
  conversationId?: string;
}

export interface ChatState {
  // ---- data ----
  conversations: ConversationSummary[];
  currentId: string | null;
  /**
   * The full message TREE for the current conversation (every edit/regenerate
   * branch), NOT just the visible list. The rendered conversation is derived as
   * the chain of parents from {@link activeLeafId} up to a root; sibling
   * branches under one parent are the selectable "versions". See
   * {@link computeVisiblePath} / {@link computeVersionInfo}.
   */
  messages: ChatMessage[];
  /** Leaf of the currently-visible branch; null for an empty conversation. */
  activeLeafId: string | null;
  model: string;
  /** Reasoning effort applied to the next turn (see REASONING_EFFORTS). */
  effort: ReasoningEffort;
  /**
   * When true, the next turn runs the Deep Research pipeline (clarifying
   * questions on the first turn, full research + report on the next).
   */
  deepResearch: boolean;
  /**
   * The project the current (or next new) chat belongs to. Drives the server's
   * system-prompt injection for new chats and the project chip in the header.
   * Null when the chat is not in a project.
   */
  activeProjectId: string | null;
  /**
   * A first message queued from the project page: the project chat is created
   * server-side, then we navigate to /c/[id] where ChatApp consumes this and
   * fires the actual send. Cleared as soon as it is consumed.
   */
  pendingSend: { conversationId: string; text: string; attachments: Attachment[] } | null;

  // ---- artifacts ----
  /** All artifacts in the current conversation, each with full version history. */
  artifacts: Artifact[];
  /** The artifact currently shown in the side panel, or null when closed. */
  openArtifactId: string | null;
  /** Selected version to display; null means "follow the latest version". */
  openArtifactVersion: number | null;

  // ---- ui / status ----
  conversationsLoading: boolean;
  messagesLoading: boolean;
  isStreaming: boolean;
  /** Id of the assistant message currently streaming (if any). */
  streamingMessageId: string | null;
  error: string | null;

  // ---- actions ----
  setModel: (model: string) => void;
  setEffort: (effort: ReasoningEffort) => void;
  setDeepResearch: (v: boolean) => void;
  loadConversations: () => Promise<void>;
  loadConversation: (id: string) => Promise<void>;
  /** Reset to a fresh chat, optionally scoped to a project. */
  newChat: (projectId?: string | null) => void;
  /** Move a conversation into a project (id) or out of one (null). */
  moveConversationToProject: (
    id: string,
    projectId: string | null,
  ) => Promise<void>;
  /**
   * Start a new chat inside a project from the project page: creates the
   * conversation (attached to the project), queues `text` as its first message,
   * and returns the new conversation id so the caller can navigate to /c/[id].
   */
  startProjectChat: (
    projectId: string,
    text: string,
    attachments: Attachment[],
  ) => Promise<string | null>;
  /** Fire a queued {@link pendingSend} for `conversationId`, if any (once). */
  consumePendingSend: (conversationId: string) => void;
  /** Open an artifact in the side panel (optionally at a specific version). */
  openArtifact: (artifactId: string, version?: number) => void;
  /** Close the artifact side panel. */
  closeArtifact: () => void;
  /** Show a specific version of the open artifact (null = latest). */
  setArtifactVersion: (version: number | null) => void;
  sendMessage: (
    text: string,
    attachments: Attachment[],
    options?: SendOptions,
  ) => Promise<void>;
  /**
   * Edit a user message: send `text` as a NEW sibling under the original's
   * parent and stream a fresh reply. The original branch is preserved and both
   * become selectable versions. No-op while streaming or before the conversation
   * exists. Reuses the original message's attachments.
   */
  editMessage: (messageId: string, text: string) => Promise<void>;
  /**
   * Regenerate an assistant reply as a NEW sibling under the same user message
   * (the prior reply is kept as a version). Defaults to the last reply on the
   * visible path when no id is given.
   */
  regenerate: (assistantMessageId?: string) => Promise<void>;
  /**
   * Page between sibling "versions" of `messageId` (edit/regenerate branches),
   * moving the active leaf to the chosen sibling's latest descendant. Persisted
   * so the choice survives a reload. No-op while streaming.
   */
  switchVersion: (messageId: string, direction: "prev" | "next") => void;
  stop: () => void;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  clearError: () => void;
}

// AbortController lives outside the store; it is not React state.
let abortController: AbortController | null = null;

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  currentId: null,
  messages: [],
  activeLeafId: null,
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  deepResearch: false,
  activeProjectId: null,
  pendingSend: null,

  artifacts: [],
  openArtifactId: null,
  openArtifactVersion: null,

  conversationsLoading: false,
  messagesLoading: false,
  isStreaming: false,
  streamingMessageId: null,
  error: null,

  setModel: (model) => set({ model }),

  setEffort: (effort) => set({ effort }),

  setDeepResearch: (deepResearch) => set({ deepResearch }),

  clearError: () => set({ error: null }),

  loadConversations: async () => {
    set({ conversationsLoading: true });
    try {
      const res = await fetch("/api/conversations", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load conversations");
      const data = (await res.json()) as ConversationSummary[];
      set({ conversations: data });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to load conversations" });
    } finally {
      set({ conversationsLoading: false });
    }
  },

  loadConversation: async (id) => {
    if (get().currentId === id && get().messages.length > 0) return;
    set({
      messagesLoading: true,
      currentId: id,
      messages: [],
      activeLeafId: null,
      artifacts: [],
      openArtifactId: null,
      openArtifactVersion: null,
    });
    try {
      const res = await fetch(`/api/conversations/${id}`, { cache: "no-store" });
      if (res.status === 404) {
        set({ error: "Conversation not found", messages: [] });
        return;
      }
      if (!res.ok) throw new Error("Failed to load conversation");
      const data = (await res.json()) as ConversationDetail;
      set({
        currentId: data.id,
        messages: data.messages,
        activeLeafId: data.activeLeafId ?? null,
        model: data.model || get().model,
        artifacts: data.artifacts ?? [],
        activeProjectId: data.projectId ?? null,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to load conversation" });
    } finally {
      set({ messagesLoading: false });
    }
  },

  newChat: (projectId) => {
    if (get().isStreaming) get().stop();
    set({
      currentId: null,
      messages: [],
      activeLeafId: null,
      error: null,
      artifacts: [],
      openArtifactId: null,
      openArtifactVersion: null,
      activeProjectId: projectId ?? null,
      // Deep Research is per-request, not a persistent conversation mode — don't
      // leak it into a fresh chat (which would silently start the clarify flow).
      deepResearch: false,
    });
  },

  moveConversationToProject: async (id, projectId) => {
    const prev = get().conversations;
    const prevActiveProjectId = get().activeProjectId;
    // Optimistically update the sidebar entry.
    set({
      conversations: prev.map((c) => (c.id === id ? { ...c, projectId } : c)),
      activeProjectId: get().currentId === id ? projectId : get().activeProjectId,
    });
    try {
      const res = await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) throw new Error("Failed to move conversation");
      const updated = (await res.json()) as ConversationSummary;
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
      }));
      // A move changes both projects' conversation counts; refresh the project
      // store so any open list/detail reflects the new membership.
      const projectStore = useProjectStore.getState();
      void projectStore.load();
      const openDetailId = projectStore.detail?.id;
      if (openDetailId) void projectStore.loadDetail(openDetailId);
    } catch (e) {
      // Revert BOTH the list and the active project (the header chip) so a
      // failed move never leaves the UI pointing at a project the chat was
      // never moved into.
      set({
        conversations: prev,
        activeProjectId: prevActiveProjectId,
        error: e instanceof Error ? e.message : "Failed to move conversation",
      });
    }
  },

  startProjectChat: async (projectId, text, attachments) => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) throw new Error("Failed to start chat");
      const convo = (await res.json()) as ConversationSummary;
      set({ pendingSend: { conversationId: convo.id, text: trimmed, attachments } });
      // Surface the new chat in the sidebar immediately.
      void get().loadConversations();
      return convo.id;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to start chat" });
      return null;
    }
  },

  consumePendingSend: (conversationId) => {
    const pending = get().pendingSend;
    if (!pending || pending.conversationId !== conversationId) return;
    // Clear before sending so a re-run (e.g. StrictMode) can't double-fire.
    set({ pendingSend: null });
    void get().sendMessage(pending.text, pending.attachments, { conversationId });
  },

  openArtifact: (artifactId, version) => {
    set({
      openArtifactId: artifactId,
      openArtifactVersion: version ?? null,
    });
  },

  closeArtifact: () => {
    set({ openArtifactId: null, openArtifactVersion: null });
  },

  setArtifactVersion: (version) => {
    set({ openArtifactVersion: version });
  },

  sendMessage: async (text, attachments, options) => {
    const trimmed = text.trim();
    if (!trimmed || get().isStreaming) return;

    const conversationId = options?.conversationId ?? get().currentId ?? undefined;
    const model = get().model;
    const effort = get().effort;
    const deepResearch = get().deepResearch;
    // Only seed a project on brand-new conversations; existing chats keep the
    // project they were created with (the server ignores it for existing ids).
    const projectId = conversationId ? undefined : get().activeProjectId ?? undefined;
    // Attach the new turn under the current active leaf (null for the first
    // message). The server also defaults to this, but sending it keeps the client
    // and server in agreement when branches exist.
    const parentId = get().activeLeafId;

    const userMessage: ChatMessage = {
      id: tempId(),
      role: "user",
      parentId,
      content: trimmed,
      attachments: attachments.length ? attachments : undefined,
      createdAt: nowIso(),
    };

    const assistantId = tempId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      parentId: userMessage.id,
      content: "",
      createdAt: nowIso(),
    };

    set((s) => ({
      messages: [...s.messages, userMessage, assistantMessage],
      activeLeafId: assistantId,
      isStreaming: true,
      streamingMessageId: assistantId,
      error: null,
    }));

    await runChatTurn(set, get, {
      body: {
        conversationId,
        message: trimmed,
        model,
        effort,
        deepResearch,
        projectId,
        parentId,
        attachments: attachments.length ? attachments : undefined,
      },
      assistantId,
      userTempId: userMessage.id,
      // parentId is the active leaf before this turn — restore it if the turn
      // fails before the server confirms any ids (see runChatTurn).
      prevActiveLeafId: parentId,
      hadConversationId: !!conversationId,
    });
  },

  editMessage: async (messageId, text) => {
    const trimmed = text.trim();
    if (!trimmed || get().isStreaming) return;
    const conversationId = get().currentId;
    if (!conversationId) return; // can't branch before the conversation exists
    const original = get().messages.find((m) => m.id === messageId);
    if (!original || original.role !== "user") return;

    const model = get().model;
    const effort = get().effort;
    const parentId = original.parentId ?? null;
    // Editing changes the text only — carry the original message's attachments.
    const attachments = original.attachments ?? [];

    const userMessage: ChatMessage = {
      id: tempId(),
      role: "user",
      parentId,
      content: trimmed,
      attachments: attachments.length ? attachments : undefined,
      createdAt: nowIso(),
    };
    const assistantId = tempId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      parentId: userMessage.id,
      content: "",
      createdAt: nowIso(),
    };

    const prevActiveLeafId = get().activeLeafId;
    set((s) => ({
      messages: [...s.messages, userMessage, assistantMessage],
      activeLeafId: assistantId,
      isStreaming: true,
      streamingMessageId: assistantId,
      error: null,
    }));

    await runChatTurn(set, get, {
      body: {
        conversationId,
        message: trimmed,
        model,
        effort,
        parentId,
        attachments: attachments.length ? attachments : undefined,
      },
      assistantId,
      userTempId: userMessage.id,
      prevActiveLeafId,
      hadConversationId: true,
    });
  },

  regenerate: async (assistantMessageId) => {
    if (get().isStreaming) return;
    const conversationId = get().currentId;
    if (!conversationId) return;
    const all = get().messages;

    // Default target: the last assistant message on the visible path.
    let targetId = assistantMessageId;
    if (!targetId) {
      const path = computeVisiblePath(all, get().activeLeafId);
      for (let i = path.length - 1; i >= 0; i--) {
        if (path[i].role === "assistant") {
          targetId = path[i].id;
          break;
        }
      }
    }
    const target = targetId ? all.find((m) => m.id === targetId) : undefined;
    if (!target || target.role !== "assistant") return;
    // The user message this reply answers — the parent the new sibling hangs off.
    const userParentId = target.parentId;
    if (!userParentId) return;

    const model = get().model;
    const effort = get().effort;

    const assistantId = tempId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      parentId: userParentId,
      content: "",
      createdAt: nowIso(),
    };

    const prevActiveLeafId = get().activeLeafId;
    set((s) => ({
      messages: [...s.messages, assistantMessage],
      activeLeafId: assistantId,
      isStreaming: true,
      streamingMessageId: assistantId,
      error: null,
    }));

    await runChatTurn(set, get, {
      body: { conversationId, regenerate: true, parentId: userParentId, model, effort },
      assistantId,
      prevActiveLeafId,
      hadConversationId: true,
    });
  },

  switchVersion: (messageId, direction) => {
    if (get().isStreaming) return;
    const all = get().messages;
    const info = computeVersionInfo(all).get(messageId);
    if (!info) return;
    const target = direction === "next" ? info.nextSiblingId : info.prevSiblingId;
    if (!target) return;
    // Follow the chosen sibling down to its latest descendant — that leaf defines
    // the whole visible path below the switch point.
    const newLeaf = deepestLeaf(all, target);
    set({ activeLeafId: newLeaf });

    // Persist the branch choice so a reload rehydrates the same path. Version
    // arrows only appear on messages with reconciled (real) sibling ids, so
    // `newLeaf` is a persisted id in practice; the PATCH is nonetheless
    // best-effort — the in-memory switch has already applied, and a rejected
    // persist (e.g. 404 on an id the server can't find) is swallowed and simply
    // means a reload would fall back to the stored leaf.
    const cid = get().currentId;
    if (cid) {
      void fetch(`/api/conversations/${cid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeLeafId: newLeaf }),
      }).catch(() => {
        /* non-fatal: the in-memory branch switch already happened */
      });
    }
  },

  stop: () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    set({ isStreaming: false, streamingMessageId: null });
  },

  renameConversation: async (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    // Optimistic update.
    const prev = get().conversations;
    set({
      conversations: prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c)),
    });
    try {
      const res = await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) throw new Error("Rename failed");
      const updated = (await res.json()) as ConversationSummary;
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
      }));
    } catch (e) {
      set({ conversations: prev, error: e instanceof Error ? e.message : "Rename failed" });
    }
  },

  deleteConversation: async (id) => {
    const prev = get().conversations;
    set({ conversations: prev.filter((c) => c.id !== id) });
    const wasCurrent = get().currentId === id;
    try {
      const res = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      if (wasCurrent) {
        set({ currentId: null, messages: [], activeLeafId: null });
        if (typeof window !== "undefined") {
          window.history.replaceState(null, "", "/");
        }
      }
    } catch (e) {
      set({ conversations: prev, error: e instanceof Error ? e.message : "Delete failed" });
    }
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SetState = (
  partial:
    | Partial<ChatState>
    | ((state: ChatState) => Partial<ChatState>),
) => void;

function applyEvent(
  event: StreamEvent,
  assistantId: string,
  toolCalls: ToolCallRecord[],
  timeline: TraceItem[],
  set: SetState,
) {
  switch (event.type) {
    case "message_id": {
      // Re-id the streaming assistant message to the server's id — in the tree,
      // as the streaming pointer, and as the active leaf (so the branch keeps
      // pointing at this reply once it has its real id).
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistantId ? { ...m, id: event.id } : m,
        ),
        streamingMessageId:
          s.streamingMessageId === assistantId ? event.id : s.streamingMessageId,
        activeLeafId: s.activeLeafId === assistantId ? event.id : s.activeLeafId,
      }));
      // From here on we keep referencing the *current* streaming id.
      assistantIdRef.current = event.id;
      break;
    }
    case "user_message": {
      // Reconcile the optimistic user bubble with its persisted id: re-id it and
      // repoint the assistant child that referenced the temp id, so the tree
      // matches what a reload would load (sibling "versions" stay coherent).
      const tmp = userIdRef.current;
      if (!tmp) break;
      set((s) => ({
        messages: s.messages.map((m) => {
          if (m.id === tmp) return { ...m, id: event.id, parentId: event.parentId };
          if (m.parentId === tmp) return { ...m, parentId: event.id };
          return m;
        }),
        activeLeafId: s.activeLeafId === tmp ? event.id : s.activeLeafId,
      }));
      userIdRef.current = event.id;
      break;
    }
    case "reasoning_delta": {
      const id = assistantIdRef.current ?? assistantId;
      if (reasoningStartRef.current === null) {
        reasoningStartRef.current = Date.now();
      }
      // Append to the open reasoning segment, or start a new one if the most
      // recent timeline item is a tool row — this is what preserves the
      // think → act → think chronology across tool calls.
      const last = timeline[timeline.length - 1];
      if (last && last.type === "reasoning") {
        timeline[timeline.length - 1] = {
          type: "reasoning",
          text: last.text + event.text,
        };
      } else {
        timeline.push({ type: "reasoning", text: event.text });
      }
      const snapshot = [...timeline];
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === id
            ? ({
                ...m,
                reasoning: (m.reasoning ?? "") + event.text,
                // Never re-open the live trace once the thinking phase has ended
                // (a late reasoning chunk after the answer started must not
                // resurrect the shimmer — it could then never be re-closed).
                reasoningStreaming: !reasoningDoneRef.current,
                timeline: snapshot,
              } as StreamingChatMessage)
            : m,
        ),
      }));
      break;
    }
    case "reasoning_done": {
      // NOT a reliable "thinking finished" signal: the model emits it after the
      // FIRST reasoning summary segment, which — on interleaved think→tool→think
      // turns — happens well before the answer. Finishing here would latch the
      // trace and later reasoning/tool events could never re-close it, leaving a
      // stuck "Thinking…" shimmer. The thinking phase ends when the answer starts
      // (first `delta`) or the turn ends (`done`/`error`); finish there instead.
      break;
    }
    case "delta": {
      const id = assistantIdRef.current ?? assistantId;
      // Answer text has begun — the thinking phase is over. Collapse the trace
      // and freeze the duration (including any tool time) now.
      if (!reasoningDoneRef.current && reasoningStartRef.current !== null) {
        finishReasoning(id, set);
      }
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === id ? { ...m, content: m.content + event.text } : m,
        ),
      }));
      break;
    }
    case "tool_call": {
      const id = assistantIdRef.current ?? assistantId;
      // A tool call means the "thinking" phase has begun even if no reasoning
      // summary preceded it, so the live trace shows for tool-only turns too.
      if (reasoningStartRef.current === null) {
        reasoningStartRef.current = Date.now();
      }
      const recordId = `${event.name}-${toolCalls.length}`;
      toolCalls.push({ id: recordId, name: event.name, args: event.args });
      timeline.push({
        type: "tool",
        id: recordId,
        tool: event.name,
        arg: extractToolArg(event.name, event.args),
        status: "running",
      });
      const snapshot = [...timeline];
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === id
            ? ({
                ...m,
                toolCalls: [...toolCalls],
                // Don't resurrect the live trace if the answer already began
                // (see the reasoning_delta guard) — keeps the one-way finish.
                reasoningStreaming: !reasoningDoneRef.current,
                timeline: snapshot,
              } as StreamingChatMessage)
            : m,
        ),
      }));
      break;
    }
    case "tool_result": {
      const id = assistantIdRef.current ?? assistantId;
      // Attach output to the most recent matching call without an output.
      for (let i = toolCalls.length - 1; i >= 0; i--) {
        if (toolCalls[i].name === event.name && toolCalls[i].output === undefined) {
          toolCalls[i] = { ...toolCalls[i], output: event.output };
          break;
        }
      }
      // Flip the matching running tool row in the timeline to done.
      for (let i = timeline.length - 1; i >= 0; i--) {
        const it = timeline[i];
        if (it.type === "tool" && it.tool === event.name && it.status === "running") {
          timeline[i] = { ...it, status: "done" };
          break;
        }
      }
      const snapshot = [...timeline];
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === id
            ? { ...m, toolCalls: [...toolCalls], timeline: snapshot }
            : m,
        ),
      }));
      break;
    }
    case "artifact": {
      const id = assistantIdRef.current ?? assistantId;
      const snap = event.artifact;
      const version: ArtifactVersion = {
        version: snap.version,
        content: snap.content,
        createdAt: snap.updatedAt,
      };
      const ref: ArtifactRef = {
        artifactId: snap.id,
        identifier: snap.identifier,
        title: snap.title,
        type: snap.type,
        version: snap.version,
        command: event.command,
      };
      set((s) => {
        const idx = s.artifacts.findIndex((a) => a.id === snap.id);
        let artifacts: Artifact[];
        if (idx === -1) {
          const created: Artifact = {
            id: snap.id,
            conversationId: s.currentId ?? "",
            identifier: snap.identifier,
            type: snap.type,
            title: snap.title,
            language: snap.language,
            versions: [version],
            createdAt: snap.createdAt,
            updatedAt: snap.updatedAt,
          };
          artifacts = [...s.artifacts, created];
        } else {
          const prev = s.artifacts[idx];
          const hasVersion = prev.versions.some((v) => v.version === snap.version);
          const versions = (
            hasVersion
              ? prev.versions.map((v) => (v.version === snap.version ? version : v))
              : [...prev.versions, version]
          ).sort((a, b) => a.version - b.version);
          const updated: Artifact = {
            ...prev,
            title: snap.title,
            type: snap.type,
            language: snap.language,
            versions,
            updatedAt: snap.updatedAt,
          };
          artifacts = s.artifacts.map((a, i) => (i === idx ? updated : a));
        }
        const messages = s.messages.map((m) =>
          m.id === id
            ? { ...m, artifactRefs: [...(m.artifactRefs ?? []), ref] }
            : m,
        );
        // Media and diagram artifacts are immediately useful inline, so avoid
        // interrupting the chat by opening the side panel for them.
        if (snap.type === "svg" || snap.type === "mermaid" || snap.type === "image") {
          return { artifacts, messages };
        }

        // Other artifacts still open on their latest version after creation.
        return {
          artifacts,
          messages,
          openArtifactId: snap.id,
          openArtifactVersion: null,
        };
      });
      break;
    }
    case "site": {
      // Record the built/deployed Site on the assistant message so its inline
      // SiteChip renders live (and survives reload — the server persists it too).
      const id = assistantIdRef.current ?? assistantId;
      const snap = event.site;
      const ref: SiteRef = {
        siteId: snap.id,
        slug: snap.slug,
        name: snap.name,
        command: event.command,
        deployed: snap.deployed,
        publicPath: snap.publicPath,
      };
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === id ? { ...m, siteRefs: [...(m.siteRefs ?? []), ref] } : m,
        ),
      }));
      break;
    }
    case "research_plan": {
      const id = assistantIdRef.current ?? assistantId;
      set((s) => ({
        messages: s.messages.map((m) => {
          if (m.id !== id) return m;
          const prev = m.research ?? { phase: "researching" as ResearchPhase };
          const research: ResearchState = {
            ...prev,
            phase: prev.phase === "report" ? "report" : "researching",
            plan: event.plan,
          };
          return { ...m, research };
        }),
      }));
      break;
    }
    case "research_activity": {
      const id = assistantIdRef.current ?? assistantId;
      set((s) => ({
        messages: s.messages.map((m) => {
          if (m.id !== id) return m;
          const prev: ResearchState = m.research ?? {
            phase: "researching",
            activities: [],
          };
          const activities = prev.activities ? [...prev.activities] : [];
          const idx = activities.findIndex((a) => a.id === event.activity.id);
          if (idx === -1) {
            activities.push(event.activity);
          } else {
            activities[idx] = event.activity;
          }
          const research: ResearchState = { ...prev, activities };
          return { ...m, research };
        }),
      }));
      break;
    }
    case "subagent_activity": {
      const id = assistantIdRef.current ?? assistantId;
      set((s) => ({
        messages: s.messages.map((m) => {
          if (m.id !== id) return m;
          const prev: SubagentState = m.subagents ?? { agents: [] };
          const agents = prev.agents ? [...prev.agents] : [];
          const idx = agents.findIndex((a) => a.id === event.activity.id);
          if (idx === -1) {
            agents.push(event.activity);
          } else {
            agents[idx] = event.activity;
          }
          return { ...m, subagents: { ...prev, agents } };
        }),
      }));
      break;
    }
    case "title": {
      set((s) => {
        const cid = s.currentId;
        if (!cid) return {};
        return { conversations: setTitle(s.conversations, cid, event.title) };
      });
      break;
    }
    case "error": {
      const id = assistantIdRef.current ?? assistantId;
      // The turn failed mid-flight: any tool row still spinning is now stuck, so
      // mark it errored, and end the thinking phase so the trace collapses to a
      // static pill instead of a permanently shimmering "Thinking…".
      failRunningTools(timeline);
      failRunningSubagents(id, set);
      finishThinking(id, timeline, set);
      set((s) => ({
        error: event.message,
        messages: appendErrorToAssistant(s.messages, id, event.message),
      }));
      break;
    }
    case "done": {
      const id = assistantIdRef.current ?? assistantId;
      // Defensive: if reasoning was streaming but never explicitly finished,
      // collapse it now so the Thinking block doesn't stay in the live state.
      if (!reasoningDoneRef.current && reasoningStartRef.current !== null) {
        finishReasoning(id, set);
      }
      // Deep Research is per-request: when a REPORT turn finishes (its message
      // carries a plan), stamp phase "report" and clear the mode so the next
      // message is a normal chat turn. A CLARIFY turn (no plan) keeps the mode on
      // so the user's next message (their answers) runs the research.
      set((s) => {
        const msg = s.messages.find((m) => m.id === id);
        if (!msg?.research?.plan) return {};
        return {
          deepResearch: false,
          messages: s.messages.map((m) =>
            m.id === id && m.research
              ? { ...m, research: { ...m.research, phase: "report" as const } }
              : m,
          ),
        };
      });
      assistantIdRef.current = null;
      break;
    }
  }
}

// Module-level ref to track the live assistant message id across delta events
// after a `message_id` re-id. Reset to null on `done`.
const assistantIdRef: { current: string | null } = { current: null };

// Temp id of the optimistic user message created this turn (null on regenerate,
// which creates none), used to reconcile it against the `user_message` event.
const userIdRef: { current: string | null } = { current: null };

/**
 * Shared streaming core for a chat turn. The caller has already inserted the
 * optimistic messages and set `isStreaming`; this runs the POST, applies the
 * SSE events (reconciling ids), refreshes the sidebar, and always clears the
 * streaming flags in `finally`. Used by sendMessage / editMessage / regenerate.
 */
async function runChatTurn(
  set: SetState,
  get: () => ChatState,
  args: {
    body: Record<string, unknown>;
    assistantId: string;
    hadConversationId: boolean;
    /** Temp id of the optimistic user message, when this turn created one. */
    userTempId?: string;
    /**
     * The active leaf BEFORE this turn's optimistic insert. If the turn fails
     * before the server confirms any ids, we restore it (and drop the temp pair)
     * so activeLeafId is never left on an unreconciled temp id.
     */
    prevActiveLeafId?: string | null;
  },
): Promise<void> {
  const { assistantId } = args;
  abortController = new AbortController();
  const toolCalls: ToolCallRecord[] = [];
  // Ordered interleaved trace (reasoning segments + tool rows) built live from
  // the SSE stream, mirroring what the server persists as `timeline`.
  const timeline: TraceItem[] = [];
  assistantIdRef.current = assistantId;
  userIdRef.current = args.userTempId ?? null;
  reasoningStartRef.current = null;
  reasoningDoneRef.current = false;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args.body),
      signal: abortController.signal,
    });

    if (!res.ok) {
      let message = "Request failed";
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(message);
    }

    const newConversationId = res.headers.get("X-Conversation-Id");
    const wasNew = !args.hadConversationId && !!newConversationId;
    if (newConversationId) {
      set({ currentId: newConversationId });
      if (typeof window !== "undefined") {
        window.history.replaceState(null, "", `/c/${newConversationId}`);
      }
    }

    for await (const event of parseSSE(res)) {
      applyEvent(event, assistantId, toolCalls, timeline, set);
    }

    // Refresh sidebar list so titles / ordering reflect the new exchange.
    if (wasNew) {
      void get().loadConversations();
    } else {
      // Bump updatedAt locally for ordering.
      const cid = get().currentId;
      if (cid) {
        set((s) => ({ conversations: bumpUpdatedAt(s.conversations, cid) }));
      }
    }
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    // Did the server confirm this turn? `message_id` re-points assistantIdRef off
    // the temp id; if it never arrived (Stop in the pre-stream window, a non-ok
    // HTTP, a network drop), nothing was reliably persisted under our temp ids.
    const reconciled = assistantIdRef.current !== assistantId;
    if (!reconciled) {
      // Drop the un-persisted optimistic pair and restore the prior active leaf,
      // so activeLeafId is never left on a temp id (the NEXT turn's parentId would
      // otherwise be unresolvable and could detach a new root / drop history).
      set((s) => ({
        messages: s.messages.filter(
          (m) => m.id !== assistantId && m.id !== args.userTempId,
        ),
        activeLeafId:
          s.activeLeafId === assistantId
            ? args.prevActiveLeafId ?? null
            : s.activeLeafId,
        ...(aborted
          ? null
          : { error: e instanceof Error ? e.message : "Something went wrong" }),
      }));
    } else {
      // The assistant already has a real id: keep it and end the thinking phase
      // (collapse the pill, mark any still-spinning tool/subagent row errored) so
      // the turn never stays stuck on a live, non-collapsible "Thinking…".
      const id = assistantIdRef.current ?? assistantId;
      failRunningTools(timeline);
      failRunningSubagents(id, set);
      finishThinking(id, timeline, set);
      if (!aborted) {
        const message = e instanceof Error ? e.message : "Something went wrong";
        set((s) => ({
          error: message,
          messages: appendErrorToAssistant(s.messages, id, message),
        }));
      }
    }
  } finally {
    abortController = null;
    set({ isStreaming: false, streamingMessageId: null });
  }
}

// Reasoning timing refs (module-level, not React state). `reasoningStartRef`
// is set on the first `reasoning_delta`; `reasoningDoneRef` guards against
// stamping the duration twice (e.g. both `reasoning_done` and the first answer
// `delta` may try to finish it).
const reasoningStartRef: { current: number | null } = { current: null };
const reasoningDoneRef: { current: boolean } = { current: false };

/**
 * Mark the reasoning summary as finished: clear the streaming flag and stamp
 * the elapsed time (ms) on the message. Idempotent within a single turn.
 */
function finishReasoning(id: string, set: SetState) {
  if (reasoningDoneRef.current) return;
  reasoningDoneRef.current = true;
  const start = reasoningStartRef.current;
  const elapsed = start !== null ? Math.max(0, Date.now() - start) : undefined;
  set((s) => ({
    messages: s.messages.map((m) =>
      m.id === id
        ? ({
            ...m,
            reasoningStreaming: false,
            // Only stamp a duration if we actually saw reasoning text.
            reasoningMs: elapsed !== undefined ? elapsed : m.reasoningMs,
          } as StreamingChatMessage)
        : m,
    ),
  }));
}

/**
 * Mark every still-"running" tool row in the (mutable) timeline as errored.
 * Called when a turn is interrupted (Stop) or fails before a tool's result
 * arrives, so the row shows a failure glyph instead of a spinner that would
 * otherwise persist forever after a reload.
 */
function failRunningTools(timeline: TraceItem[]) {
  for (let i = 0; i < timeline.length; i++) {
    const it = timeline[i];
    if (it.type === "tool" && it.status === "running") {
      timeline[i] = { ...it, status: "error" };
    }
  }
}

/**
 * The subagent counterpart to {@link failRunningTools}: when a turn is stopped
 * or errors while workers are still dispatched, no terminal `subagent_activity`
 * event will arrive for the in-flight ones, so flip any still-"running" worker
 * to "failed". Without this, the collapsed "Subagents" panel would show a
 * perpetual spinner in the live session until a reload rehydrates the server's
 * finalized state (finalizeSubagents). No-op when nothing is running.
 */
function failRunningSubagents(id: string, set: SetState) {
  const now = Date.now();
  set((s) => ({
    messages: s.messages.map((m) => {
      if (m.id !== id || !m.subagents?.agents?.length) return m;
      if (!m.subagents.agents.some((a) => a.status === "running")) return m;
      return {
        ...m,
        subagents: {
          ...m.subagents,
          agents: m.subagents.agents.map((a) =>
            a.status === "running"
              ? {
                  ...a,
                  status: "failed" as const,
                  // Freeze the live timer and close any in-flight trace step.
                  endedAt: a.startedAt ? (a.endedAt ?? now) : a.endedAt,
                  trace: a.trace?.map((t) =>
                    t.status === "running" ? { ...t, status: "done" as const } : t,
                  ),
                }
              : a,
          ),
        },
      };
    }),
  }));
}

/**
 * End the thinking phase: collapse the trace (finishReasoning) and flush the
 * latest timeline snapshot to the message so any status changes (e.g. a tool
 * flipped to "error") are reflected. Safe to call after finishReasoning already
 * ran — it still re-writes the timeline.
 */
function finishThinking(id: string, timeline: TraceItem[], set: SetState) {
  finishReasoning(id, set);
  const snapshot = [...timeline];
  set((s) => ({
    messages: s.messages.map((m) => (m.id === id ? { ...m, timeline: snapshot } : m)),
  }));
}

function appendErrorToAssistant(
  messages: ChatMessage[],
  id: string,
  message: string,
): ChatMessage[] {
  return messages.map((m) => {
    if (m.id !== id) return m;
    const note = `\n\n_Error: ${message}_`;
    return { ...m, content: m.content ? m.content + note : `_Error: ${message}_` };
  });
}

function bumpUpdatedAt(
  list: ConversationSummary[],
  id: string,
): ConversationSummary[] {
  const now = nowIso();
  const updated = list.map((c) => (c.id === id ? { ...c, updatedAt: now } : c));
  return [...updated].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function setTitle(
  list: ConversationSummary[],
  id: string,
  title: string,
): ConversationSummary[] {
  return list.map((c) => (c.id === id ? { ...c, title } : c));
}

// ---------------------------------------------------------------------------
// Message-tree helpers (edit / regenerate branching)
// ---------------------------------------------------------------------------

/** Version position of a message among its same-parent siblings. */
export interface VersionInfo {
  /** 0-based index of this message among its siblings (creation order). */
  index: number;
  /** Number of sibling versions (>= 1). */
  count: number;
  /** Previous sibling id, or null when this is the first version. */
  prevSiblingId: string | null;
  /** Next sibling id, or null when this is the last version. */
  nextSiblingId: string | null;
}

/**
 * Group messages by parent (null parent = roots), each list ordered by creation
 * time then id so sibling "versions" page in a stable, oldest-first order.
 */
function childrenByParent(
  all: ChatMessage[],
): Map<string | null, ChatMessage[]> {
  const map = new Map<string | null, ChatMessage[]>();
  for (const m of all) {
    const key = m.parentId ?? null;
    const arr = map.get(key);
    if (arr) arr.push(m);
    else map.set(key, [m]);
  }
  for (const arr of map.values()) {
    arr.sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }
  return map;
}

/**
 * The visible conversation: the chain of parents from `leafId` up to a root,
 * returned root-first. Falls back to the latest-created message as the leaf when
 * `leafId` is missing/unresolved (e.g. legacy data), and returns [] for an empty
 * tree. Cycle-safe.
 */
export function computeVisiblePath(
  all: ChatMessage[],
  leafId: string | null,
): ChatMessage[] {
  if (all.length === 0) return [];
  const byId = new Map(all.map((m) => [m.id, m]));
  let leaf = leafId ? byId.get(leafId) : undefined;
  if (!leaf) {
    // No usable leaf: pick the newest message so the UI still shows something.
    leaf = [...all].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )[all.length - 1];
  }
  const path: ChatMessage[] = [];
  const seen = new Set<string>();
  let cur: ChatMessage | undefined = leaf;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

/** Per-message version info (siblings sharing a parent are versions). */
export function computeVersionInfo(all: ChatMessage[]): Map<string, VersionInfo> {
  const info = new Map<string, VersionInfo>();
  for (const siblings of childrenByParent(all).values()) {
    const count = siblings.length;
    siblings.forEach((m, i) => {
      info.set(m.id, {
        index: i,
        count,
        prevSiblingId: i > 0 ? siblings[i - 1].id : null,
        nextSiblingId: i < count - 1 ? siblings[i + 1].id : null,
      });
    });
  }
  return info;
}

/**
 * The deepest descendant of `startId`, following the latest-created child at
 * each step — i.e. the leaf that a freshly-picked branch should point at.
 * Cycle-safe; returns `startId` when it has no children.
 */
export function deepestLeaf(all: ChatMessage[], startId: string): string {
  const kids = childrenByParent(all);
  let cur = startId;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const children = kids.get(cur);
    if (!children || children.length === 0) return cur;
    cur = children[children.length - 1].id;
  }
  return cur;
}
