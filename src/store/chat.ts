"use client";

import { create } from "zustand";
import type {
  Artifact,
  ArtifactRef,
  ArtifactVersion,
  Attachment,
  ChatMessage,
  ConversationDetail,
  ConversationSummary,
  StreamEvent,
  ToolCallRecord,
} from "@/lib/types";
import { DEFAULT_MODEL, DEFAULT_EFFORT } from "@/lib/types";
import type { ReasoningEffort } from "@/lib/types";
import { parseSSE } from "@/lib/sse";

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
  messages: ChatMessage[];
  model: string;
  /** Reasoning effort applied to the next turn (see REASONING_EFFORTS). */
  effort: ReasoningEffort;

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
  loadConversations: () => Promise<void>;
  loadConversation: (id: string) => Promise<void>;
  newChat: () => void;
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
  regenerate: () => Promise<void>;
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
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,

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
        model: data.model || get().model,
        artifacts: data.artifacts ?? [],
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to load conversation" });
    } finally {
      set({ messagesLoading: false });
    }
  },

  newChat: () => {
    if (get().isStreaming) get().stop();
    set({
      currentId: null,
      messages: [],
      error: null,
      artifacts: [],
      openArtifactId: null,
      openArtifactVersion: null,
    });
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

    const userMessage: ChatMessage = {
      id: tempId(),
      role: "user",
      content: trimmed,
      attachments: attachments.length ? attachments : undefined,
      createdAt: nowIso(),
    };

    const assistantId = tempId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: nowIso(),
    };

    set((s) => ({
      messages: [...s.messages, userMessage, assistantMessage],
      isStreaming: true,
      streamingMessageId: assistantId,
      error: null,
    }));

    abortController = new AbortController();
    const toolCalls: ToolCallRecord[] = [];
    assistantIdRef.current = assistantId;
    reasoningStartRef.current = null;
    reasoningDoneRef.current = false;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          message: trimmed,
          model,
          effort,
          attachments: attachments.length ? attachments : undefined,
        }),
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
      const wasNew = !conversationId && !!newConversationId;
      if (newConversationId) {
        set({ currentId: newConversationId });
        if (typeof window !== "undefined") {
          window.history.replaceState(null, "", `/c/${newConversationId}`);
        }
      }

      for await (const event of parseSSE(res)) {
        applyEvent(event, assistantId, toolCalls, set);
      }

      // Refresh sidebar list so titles / ordering reflect the new exchange.
      if (wasNew) {
        void get().loadConversations();
      } else {
        // Bump updatedAt locally for ordering.
        const cid = get().currentId;
        if (cid) {
          set((s) => ({
            conversations: bumpUpdatedAt(s.conversations, cid),
          }));
        }
      }
    } catch (e) {
      const aborted =
        e instanceof DOMException && e.name === "AbortError";
      if (!aborted) {
        const message = e instanceof Error ? e.message : "Something went wrong";
        set((s) => ({
          error: message,
          messages: appendErrorToAssistant(s.messages, assistantId, message),
        }));
      }
    } finally {
      abortController = null;
      set({ isStreaming: false, streamingMessageId: null });
    }
  },

  regenerate: async () => {
    if (get().isStreaming) return;
    const messages = get().messages;
    // Find the last user message; drop everything after it and resend.
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return;
    const lastUser = messages[lastUserIdx];
    set({ messages: messages.slice(0, lastUserIdx) });
    await get().sendMessage(lastUser.content, lastUser.attachments ?? [], {
      conversationId: get().currentId ?? undefined,
    });
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
        set({ currentId: null, messages: [] });
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
  set: SetState,
) {
  switch (event.type) {
    case "message_id": {
      // Re-id the streaming assistant message to the server's id.
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistantId ? { ...m, id: event.id } : m,
        ),
        streamingMessageId:
          s.streamingMessageId === assistantId ? event.id : s.streamingMessageId,
      }));
      // From here on we keep referencing the *current* streaming id.
      assistantIdRef.current = event.id;
      break;
    }
    case "reasoning_delta": {
      const id = assistantIdRef.current ?? assistantId;
      if (reasoningStartRef.current === null) {
        reasoningStartRef.current = Date.now();
      }
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === id
            ? ({
                ...m,
                reasoning: (m.reasoning ?? "") + event.text,
                reasoningStreaming: true,
              } as StreamingChatMessage)
            : m,
        ),
      }));
      break;
    }
    case "reasoning_done": {
      finishReasoning(assistantIdRef.current ?? assistantId, set);
      break;
    }
    case "delta": {
      const id = assistantIdRef.current ?? assistantId;
      // Answer text has begun; if a reasoning summary was streaming and never
      // received an explicit `reasoning_done`, collapse it now (per contract §9).
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
      const record: ToolCallRecord = {
        id: `${event.name}-${toolCalls.length}`,
        name: event.name,
        args: event.args,
      };
      toolCalls.push(record);
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === id ? { ...m, toolCalls: [...toolCalls] } : m,
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
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === id ? { ...m, toolCalls: [...toolCalls] } : m,
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
      set((s) => ({
        error: event.message,
        messages: appendErrorToAssistant(s.messages, id, event.message),
      }));
      break;
    }
    case "done":
      // Defensive: if reasoning was streaming but never explicitly finished,
      // collapse it now so the Thinking block doesn't stay in the live state.
      if (!reasoningDoneRef.current && reasoningStartRef.current !== null) {
        finishReasoning(assistantIdRef.current ?? assistantId, set);
      }
      assistantIdRef.current = null;
      break;
  }
}

// Module-level ref to track the live assistant message id across delta events
// after a `message_id` re-id. Reset to null on `done`.
const assistantIdRef: { current: string | null } = { current: null };

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
