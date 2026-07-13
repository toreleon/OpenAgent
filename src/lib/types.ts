/**
 * Shared TypeScript types used across OpenAgent.
 * Every agent imports the relevant symbols from "@/lib/types".
 */

import type { ToolIconKey } from "@/lib/toolActivity";

// ---------------------------------------------------------------------------
// Core chat primitives
// ---------------------------------------------------------------------------

export type ChatRole = "user" | "assistant" | "system" | "tool";

/** A file or image attached to a message. */
export interface Attachment {
  id: string;
  name: string;
  /** MIME type, e.g. "image/png" or "application/pdf". */
  type: string;
  /** Size in bytes. */
  size: number;
  /** Public URL to fetch the file (e.g. "/uploads/<id>.png"). */
  url: string;
  /** Coarse classification used by the UI to decide how to render. */
  kind: "image" | "file";
}

/** A record of a tool invocation and (optionally) its result. */
export interface ToolCallRecord {
  /** Stable id correlating a call to its result. */
  id: string;
  name: string;
  /** JSON-serializable arguments passed to the tool. */
  args: unknown;
  /** JSON-serializable output, present once the tool has returned. */
  output?: unknown;
}

/**
 * One item in an assistant turn's ordered "thinking" timeline — the interleaved,
 * chronological record of reasoning summaries and tool activity that is
 * shown above the answer (and collapses to "Thought for Ns"). The `seq`-ordered
 * array is the canonical, reload-safe shape: a reasoning chunk produced AFTER a
 * tool call carries a later position and renders after that tool's row, so
 * think→act→think interleaving survives persistence. Kept deliberately lean
 * (a single summarized `arg`, never raw args/output) so it never bloats the row.
 */
export type TraceItem =
  | {
      type: "reasoning";
      /** Accumulated reasoning summary markdown for this segment. */
      text: string;
    }
  | {
      type: "tool";
      /** Stable id (pairs a running tool row to its completion). */
      id: string;
      /** Internal tool name (e.g. "web_search"); never rendered to the user. */
      tool: string;
      /** One summarized argument (query, hostname, or file basename); may be absent. */
      arg?: string;
      /** Lifecycle of the call. `running` until its result arrives. */
      status: "running" | "done" | "error";
    };

/** A single chat message as used on the client and serialized over the API. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  /**
   * Parent message id in the conversation TREE, or null for a root message.
   * Editing a user message / regenerating an assistant reply
   * creates a NEW sibling under the same parent, so a parent's children are the
   * selectable "versions". The visible conversation is the chain of parents from
   * the conversation's active leaf up to a root. Absent on legacy in-flight
   * shapes; the server always sends it for persisted messages.
   */
  parentId?: string | null;
  content: string;
  attachments?: Attachment[];
  toolCalls?: ToolCallRecord[];
  /**
   * The model's reasoning summary text (assistant messages only). Accumulated
   * from `reasoning_delta` stream events and persisted so the "Thinking" block
   * survives reloads. Absent when the model produced no reasoning summary.
   */
  reasoning?: string;
  /**
   * Total "thinking" wall-clock in milliseconds — reasoning plus any tool time,
   * frozen when the final answer starts. Drives the collapsed "Thought for Ns" /
   * "Worked for Ns" pill. (Historically named for reasoning only; it now spans
   * the whole pre-answer phase.)
   */
  reasoningMs?: number;
  /**
   * The ordered, interleaved thinking timeline (reasoning segments + tool
   * activity) rendered in the collapsible trace above the answer. Present on
   * assistant messages that reasoned and/or used tools. When absent on a legacy
   * message, the UI synthesizes a best-effort timeline from `reasoning` +
   * `toolCalls`. See {@link TraceItem}.
   */
  timeline?: TraceItem[];
  /**
   * Artifacts this (assistant) message created or updated, in call order. Used
   * to render inline "artifact chips" that open the artifact panel. Absent when
   * the message produced no artifacts.
   */
  artifactRefs?: ArtifactRef[];
  /**
   * Sites this (assistant) message built or deployed, in call order. Used to
   * render inline "site chips" that open the Sites UI. Absent otherwise.
   */
  siteRefs?: SiteRef[];
  /**
   * Deep-research state (assistant messages produced in Deep Research mode).
   * Holds the plan + live activity log rendered in the collapsible "Research"
   * block above the report. The report itself is this message's `content`.
   * Absent for normal chat turns.
   */
  research?: ResearchState;
  /**
   * Parallel-subagent state (assistant messages where the model called the
   * `run_subagents` tool). Holds the live per-worker status log rendered in the
   * collapsible "Subagents" block above the synthesized answer. Absent for turns
   * that dispatched no subagents. See {@link SubagentState}.
   */
  subagents?: SubagentState;
  /**
   * Built-in browser-control state (assistant messages where the model drove the
   * browser tools). Holds the live action trace + latest screenshot rendered in
   * the collapsible "Browser" block above the answer. Absent for turns that did
   * no browsing. See {@link BrowserState}.
   */
  browser?: BrowserState;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Deep Research
// ---------------------------------------------------------------------------

/** Which stage of a Deep Research exchange an assistant message represents. */
export type ResearchPhase = "clarifying" | "researching" | "report";

/** The research plan produced before searching begins. */
export interface ResearchPlan {
  /** A concise topic/title for the report. */
  title: string;
  /** The angles the research investigates; each drives one or more searches. */
  subtopics: { title: string; queries: string[] }[];
}

export type ResearchActivityKind = "search" | "source" | "analyze" | "synthesize";
export type ResearchActivityStatus = "active" | "done" | "failed";

/** One line in the live research activity log. Streamed updates REPLACE the
 * entry with the same `id` (a search that finishes, a source that finishes
 * reading), so the id must be stable across its lifecycle. */
export interface ResearchActivity {
  id: string;
  kind: ResearchActivityKind;
  /** Human-readable label: a search query, a page title, or a phase name. */
  title: string;
  /** For `source` activities: the page URL (used to render a link/favicon). */
  url?: string;
  status: ResearchActivityStatus;
}

/** Accumulated Deep Research state, persisted (JSON) on the assistant message. */
export interface ResearchState {
  phase: ResearchPhase;
  /** The research brief (original query + any clarification answers). */
  brief?: string;
  plan?: ResearchPlan;
  /** The activity log, in emission order. */
  activities?: ResearchActivity[];
  /** Count of sources successfully read (for the collapsed summary line). */
  sourceCount?: number;
}

// ---------------------------------------------------------------------------
// Parallel subagents (Claude-Desktop-style orchestrator → workers)
// ---------------------------------------------------------------------------

/** Lifecycle of one dispatched subagent worker. */
export type SubagentStatus = "running" | "done" | "failed";

/**
 * One step in a subagent's live working trace — a single tool action it took,
 * shown as a row when the worker's card is expanded in the working view. `label`
 * is the friendly, already-tensed phrasing (e.g. "Searched the web for …") and
 * `icon` selects the leading glyph. A step is `running` while the tool is
 * in-flight and flips to `done` once the next tool starts (or the worker
 * settles). Mirrors the timeline's tool-activity rows, scoped to one worker.
 */
export interface SubagentTraceStep {
  /** Friendly, tensed label for the tool action (from {@link toolActivityLabel}). */
  label: string;
  /** Leading icon key (from {@link toolActivityIcon}), resolved to a glyph in the UI. */
  icon: ToolIconKey;
  /** `running` while the tool is in-flight; `done` once the next step begins. */
  status: "running" | "done";
}

/**
 * One worker in a parallel-subagent batch, rendered as a live CARD in the
 * "Subagents" working view above the orchestrator's synthesized answer.
 * Streamed updates REPLACE the entry with the same `id` (each emit is a FULL
 * snapshot: running → accumulating trace → done|failed), so the id must be
 * stable across the worker's lifecycle. Mirrors {@link ResearchActivity}'s
 * upsert-by-id contract.
 */
export interface SubagentActivity {
  /** Stable id for this worker within the batch, e.g. "sub-0". */
  id: string;
  /** The subtask title the orchestrator assigned this worker. */
  title: string;
  status: SubagentStatus;
  /** Number of tool calls the worker has made so far (live counter). */
  steps?: number;
  /**
   * A compact live/final note: the worker's current action while running
   * (e.g. "Searching the web for …"), or a one-line result/error once settled.
   */
  detail?: string;
  /**
   * The worker's full ordered tool timeline, appended one step per tool call, so
   * the working-view card can be expanded to show everything it did (not just
   * the latest step). Absent until the worker makes its first tool call.
   */
  trace?: SubagentTraceStep[];
  /**
   * Epoch-ms when the worker actually STARTED running (absent while it is still
   * queued behind the concurrency limit). Powers the live per-agent elapsed
   * timer; the UI counts up from here until {@link endedAt}.
   */
  startedAt?: number;
  /**
   * Epoch-ms when the worker SETTLED (done|failed); absent while running. With
   * {@link startedAt} this yields the final, reload-stable run duration.
   */
  endedAt?: number;
}

/**
 * Accumulated parallel-subagent state, persisted (JSON) on the assistant
 * message so the panel rehydrates after a reload. Mirrors {@link ResearchState}.
 */
export interface SubagentState {
  /** Each dispatched worker, in dispatch order. */
  agents: SubagentActivity[];
}

/** Status of one built-in-browser action (and of the browsing card overall). */
export type BrowserStepStatus = "running" | "done" | "failed";

/**
 * One step in the built-in browser's live trace — a single action it took
 * (navigate/snapshot/click/type/screenshot), shown as a row in the "Browser"
 * working view. `running` while the action is in-flight; flips to `done` (or
 * `failed`) once it settles. Mirrors {@link SubagentTraceStep}, plus `failed`.
 */
export interface BrowserTraceStep {
  /** Friendly, tensed label, e.g. "Navigating to example.com". */
  label: string;
  /** Leading icon key, resolved to a glyph in the UI. */
  icon: ToolIconKey;
  status: BrowserStepStatus;
}

/**
 * The built-in browser's live working card, rendered above the assistant's
 * answer. Streamed updates REPLACE the entry with the same `id` (each emit is a
 * FULL snapshot: running → accumulating trace → done|failed), so the id is stable
 * across the turn. Mirrors {@link SubagentActivity}'s upsert-by-id contract; a P0
 * turn produces a single card with id "browser-0".
 */
export interface BrowserActivity {
  /** Stable id for the browsing card within this turn, e.g. "browser-0". */
  id: string;
  status: BrowserStepStatus;
  /** Current page URL after the latest action. */
  url?: string;
  /** Current page title after the latest action. */
  title?: string;
  /** A compact live/final note: the current or most recent action. */
  action?: string;
  /** Latest page screenshot as a data URL, shown in the panel (diagnostic-only). */
  thumbnailDataUrl?: string;
  /** Number of browser actions taken so far (live counter). */
  steps?: number;
  /** The ordered action timeline, appended one step per tool call. */
  trace?: BrowserTraceStep[];
  /** Epoch-ms when browsing started (powers the live elapsed timer). */
  startedAt?: number;
  /** Epoch-ms when the browsing card settled (done|failed); absent while running. */
  endedAt?: number;
}

/**
 * Accumulated built-in-browser state, persisted (JSON) on the assistant message
 * so the panel rehydrates after a reload. Mirrors {@link SubagentState}.
 */
export interface BrowserState {
  /** The browsing card(s) for this turn (one, "browser-0", in P0). */
  activities: BrowserActivity[];
}

/**
 * Canonical tool name for the parallel-subagent dispatcher. Shared so the tool
 * definition, the /api/chat route (which suppresses this tool's generic "tool"
 * card in favor of the rich Subagents panel), and any client agree on the exact
 * string.
 */
export const SUBAGENT_TOOL_NAME = "run_subagents";

/** True if `name` is the parallel-subagent dispatcher tool. */
export function isSubagentToolName(name: string): boolean {
  return name === SUBAGENT_TOOL_NAME;
}

// ---------------------------------------------------------------------------
// Conversations & models
// ---------------------------------------------------------------------------

/** Lightweight conversation entry for the sidebar list. */
export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  /** Owning project id, or null when the conversation is not in a project. */
  projectId: string | null;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

/** Full conversation with its messages. */
export interface ConversationDetail extends ConversationSummary {
  /** ISO 8601 timestamp. */
  createdAt: string;
  /**
   * The full message TREE (every branch), not just the visible path. The client
   * derives the visible conversation as the chain of parents from
   * {@link activeLeafId} up to a root, and pages sibling branches as "versions".
   */
  messages: ChatMessage[];
  /**
   * Leaf of the currently-visible branch. Null only for an empty conversation.
   * See {@link ChatMessage.parentId}.
   */
  activeLeafId: string | null;
  /** All artifacts produced in this conversation, each with full version history. */
  artifacts: Artifact[];
}

/** A selectable model in the model picker. */
export interface AvailableModel {
  id: string;
  label: string;
  description: string;
}

/** The list of models exposed in the UI. `id` values are passed verbatim to the agent. */
export const MODELS: AvailableModel[] = [
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    description: "Fast, capable model for most tasks",
  },
];

// NOTE: The server resolves the effective model from the OPENAI_MODEL env var
// when set (see src/lib/agent.ts), so this list is what the picker displays;
// the deployment name in OPENAI_MODEL is authoritative for the actual request.

/** Default model used when none is selected. */
export const DEFAULT_MODEL = MODELS[0].id;

// ---------------------------------------------------------------------------
// Reasoning effort
// ---------------------------------------------------------------------------

/**
 * Reasoning effort levels the user can select alongside the model.
 *
 * VERIFIED (2026-06-17) against the configured Azure endpoint with the
 * effective model `gpt-5.4-mini` (deployment `gpt-5.4-mini-2026-03-17`):
 * the model REJECTS `'minimal'` with a 400 (`unsupported_value`) and accepts
 * `'none' | 'low' | 'medium' | 'high' | 'xhigh'`. We expose the four standard
 * standard tiers below (`low | medium | high`) plus `minimal`, which the
 * SDK/OpenAI types allow but THIS model rejects — see the comment on `minimal`.
 */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/** A selectable reasoning-effort tier for the UI picker. */
export interface ReasoningEffortOption {
  id: ReasoningEffort;
  label: string;
  description: string;
  /**
   * False when the effective model is known to reject this value (the server
   * never sends a rejected value — it falls back to DEFAULT_EFFORT). The UI may
   * hide or disable unsupported options.
   */
  supported: boolean;
}

/**
 * Reasoning-effort tiers shown in the picker.
 *
 * NOTE: `minimal` is marked `supported: false` because the verified effective
 * model (`gpt-5.4-mini`) 400s on it. It is kept in the type/list so the picker
 * compiles uniformly and so other (future) models that DO support it work; the
 * server must coerce an unsupported value to DEFAULT_EFFORT before sending.
 */
export const REASONING_EFFORTS: ReasoningEffortOption[] = [
  {
    id: "minimal",
    label: "Instant",
    description: "Answer immediately with little to no reasoning",
    supported: false,
  },
  {
    id: "low",
    label: "Light",
    description: "Quick answers with a little thinking",
    supported: true,
  },
  {
    id: "medium",
    label: "Standard",
    description: "Balanced reasoning for most tasks",
    supported: true,
  },
  {
    id: "high",
    label: "Thinking harder",
    description: "Deeper reasoning for complex problems",
    supported: true,
  },
];

/** Default reasoning effort. `medium` is supported by the effective model. */
export const DEFAULT_EFFORT: ReasoningEffort = "medium";

// ---------------------------------------------------------------------------
// SSE streaming protocol (POST /api/chat)
// ---------------------------------------------------------------------------

/**
 * Events streamed from POST /api/chat.
 * Wire format: each event is sent as a single SSE line: `data: <json>\n\n`.
 */
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning_done" }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; output: unknown }
  | { type: "message_id"; id: string }
  /**
   * Emitted once right after the server persists this turn's USER message (edit
   * or normal send), carrying its real id + parent so the client can reconcile
   * the optimistic user bubble and its parent pointer. Not emitted on a
   * regenerate turn (which creates no new user message). See CONTRACTS.md.
   */
  | { type: "user_message"; id: string; parentId: string | null }
  | { type: "title"; title: string }
  /**
   * Emitted when the assistant creates/updates/rewrites an artifact (i.e. calls
   * one of the artifact tools). Carries the full new-version snapshot so the
   * client can open or refresh the artifact panel live. See CONTRACTS.md.
   */
  | { type: "artifact"; command: ArtifactCommand; artifact: ArtifactSnapshot }
  /**
   * Emitted when the assistant builds or deploys a Site (i.e. calls one of the
   * site tools). Carries the current Site snapshot so the client can open or
   * refresh the in-chat Site panel live. See CONTRACTS.md.
   */
  | { type: "site"; command: SiteCommand; site: SiteSnapshot }
  /** Deep Research: the plan, emitted once after planning completes. */
  | { type: "research_plan"; plan: ResearchPlan }
  /**
   * Deep Research: a live activity-log entry (a search started/finished, a
   * source being read, an analysis/synthesis step). An entry with an existing
   * `activity.id` REPLACES the prior one; a new id appends.
   */
  | { type: "research_activity"; activity: ResearchActivity }
  /**
   * Deep Research: the finished report, emitted once at the end of the pipeline.
   * Carries the full GitHub-flavored Markdown report + a title. The /api/chat
   * route consumes this INTERNALLY — it never forwards this event to the client;
   * instead it persists the report as a `markdown` artifact and emits an
   * `artifact` event, so the report opens as a document in the side panel rather
   * than as inline chat text. See src/lib/research/orchestrator.ts.
   */
  | { type: "research_report"; title: string; content: string }
  /**
   * Parallel subagents: a live status update for one dispatched worker. An
   * update with an existing `activity.id` REPLACES the prior one (running →
   * done|failed); a new id appends. Emitted from INSIDE the `run_subagents`
   * tool via the RunContext `onEvent` side channel (see src/lib/agent.ts and
   * src/lib/subagents/runner.ts), not by the SDK event loop.
   */
  | { type: "subagent_activity"; activity: SubagentActivity }
  /**
   * Built-in browser control: a live update for the browsing card. An update
   * with an existing `activity.id` REPLACES the prior one (running →
   * done|failed); a new id appends. Emitted from INSIDE the browser tools via
   * the RunContext `onEvent` side channel (see src/lib/browser/session.ts), not
   * by the SDK event loop.
   */
  | { type: "browser_activity"; activity: BrowserActivity }
  | { type: "done" }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// API request/response bodies
// ---------------------------------------------------------------------------

/** Request body for POST /api/chat. */
export interface ChatRequest {
  /** Existing conversation to append to. If omitted, the server creates one. */
  conversationId?: string;
  /** The user's message text. */
  message: string;
  /** Model id (one of MODELS[].id). */
  model: string;
  /** Optional attachments uploaded via POST /api/upload. */
  attachments?: Attachment[];
  /**
   * When true, this turn runs in Deep Research mode: the server plans, runs many
   * web searches + page fetches, and synthesizes a long cited report — first
   * asking clarifying questions, then (on the follow-up turn) producing the
   * report. Streams `research_plan` / `research_activity` events alongside the
   * report `delta`s. Defaults to false (normal chat).
   */
  deepResearch?: boolean;
  /**
   * When starting a NEW conversation (no `conversationId`), the project to create
   * it in. Must be owned by the user; an unknown/unowned id is ignored (the chat
   * is created without a project). Ignored when appending to an existing
   * conversation — its project membership is fixed at creation.
   */
  projectId?: string;
  /**
   * Reasoning effort for this turn. Flows ChatRequest.effort -> streamChat ->
   * Agent modelSettings.providerData.reasoning. Defaults to DEFAULT_EFFORT when
   * omitted; the server coerces unsupported values to DEFAULT_EFFORT.
   */
  effort?: ReasoningEffort;
  /**
   * The message this turn attaches under in the conversation TREE (see
   * {@link ChatMessage.parentId}):
   *  - Normal send: the current active leaf (or null / omitted for the first
   *    message). The new user message becomes a child of it.
   *  - Edit: the parent of the user message being edited — so the new (edited)
   *    user message is a SIBLING version of the original.
   *  - Regenerate ({@link regenerate} = true): the USER message to re-answer;
   *    the fresh assistant reply becomes a sibling version of the prior one.
   * When omitted the server defaults to the conversation's active leaf (then the
   * most recent message, for legacy chats without one).
   */
  parentId?: string | null;
  /**
   * When true, re-answer an existing user message: no new user message is
   * created; a fresh assistant reply is added as a sibling under
   * {@link parentId} (which must name a user message in this conversation). The
   * `message` field is ignored — the existing user turn's text is reused.
   */
  regenerate?: boolean;
}

/** Request body for POST /api/register. */
export interface RegisterRequest {
  name: string;
  email: string;
  password: string;
}

/** Request body for POST /api/conversations. */
export interface CreateConversationRequest {
  /** Optional initial title. Defaults to "New chat". */
  title?: string;
  /** Model id; defaults to DEFAULT_MODEL. */
  model?: string;
  /** Optional project to create the conversation in (must be owned by the user). */
  projectId?: string;
}

/**
 * Request body for PATCH /api/conversations/[id]. All fields optional; at least
 * one must be provided. `title` renames; `projectId` moves the conversation into
 * a project (a project id) or removes it from its project (explicit `null`).
 */
export interface UpdateConversationRequest {
  title?: string;
  projectId?: string | null;
  /**
   * Switch the visible branch by pointing at a new leaf message (must belong to
   * this conversation). Set when the user pages between edit/regenerate versions
   * so the choice survives a reload. See {@link ChatMessage.parentId}.
   */
  activeLeafId?: string;
}

/** Response body for POST /api/upload. */
export interface UploadResponse {
  attachments: Attachment[];
}

/** Generic error response shape returned by JSON (non-stream) routes. */
export interface ApiError {
  error: string;
}

// ---------------------------------------------------------------------------
// MCP connectors (remote MCP servers)
// ---------------------------------------------------------------------------

/**
 * Connection/authorization state of a connector.
 * - "none"      — server needs no auth and isn't connected yet (transient)
 * - "pending"   — awaiting OAuth sign-in (an authorizationUrl was issued)
 * - "connected" — initialized; tools discovered and usable
 * - "error"     — last connect/list/call failed (see `lastError`)
 */
export type McpAuthStatus = "none" | "pending" | "connected" | "error";

/** A tool discovered on an MCP server, surfaced in the connector UI. */
export interface McpToolInfo {
  name: string;
  description?: string;
}

/**
 * Sanitized connector shape returned by the /api/mcp routes. NEVER includes
 * OAuth tokens, client secrets, or PKCE material — those stay server-side on
 * the McpServer row.
 */
export interface McpConnector {
  id: string;
  name: string;
  url: string;
  description?: string;
  enabled: boolean;
  trusted: boolean;
  authStatus: McpAuthStatus;
  /** Tools discovered on the server (empty until connected). */
  tools: McpToolInfo[];
  /** Human-readable last error, when authStatus is "error". */
  lastError?: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

/** Request body for POST /api/mcp. */
export interface CreateMcpConnectorRequest {
  name: string;
  url: string;
  description?: string;
  /** Must be true — the user acknowledges they trust this connector. */
  trusted: boolean;
}

/** Request body for PATCH /api/mcp/[id]. All fields optional. */
export interface UpdateMcpConnectorRequest {
  name?: string;
  description?: string;
  enabled?: boolean;
  trusted?: boolean;
}

/**
 * Response from POST /api/mcp and POST /api/mcp/[id]/connect. When
 * `authorizationUrl` is present the client must open it (popup) to complete the
 * OAuth sign-in; the connector flips to "connected" via the OAuth callback.
 */
export interface McpConnectResponse {
  connector: McpConnector;
  authorizationUrl?: string;
}

// ---------------------------------------------------------------------------
// Artifacts (Claude-Desktop-style side-panel content)
// ---------------------------------------------------------------------------

/**
 * The kind of an artifact, which determines how the panel renders it:
 * - "code"     — syntax-highlighted source (has a `language`); no live preview
 * - "markdown" — rendered as Markdown (Preview) or raw (Code)
 * - "html"     — a full HTML document rendered in a sandboxed iframe
 * - "svg"      — an SVG image rendered in a sandboxed iframe
 * - "image"    — an image URL or data URL rendered directly
 * - "mermaid"  — a Mermaid diagram rendered in a sandboxed iframe (CDN)
 * - "react"    — an interactive React component rendered in a sandboxed iframe
 *                (Babel-standalone + esm.sh import map)
 */
export type ArtifactType =
  | "code"
  | "markdown"
  | "html"
  | "svg"
  | "image"
  | "mermaid"
  | "react";

/** All artifact types, in display order. */
export const ARTIFACT_TYPES: ArtifactType[] = [
  "code",
  "markdown",
  "html",
  "svg",
  "image",
  "mermaid",
  "react",
];

/** Whether an artifact type has a distinct rendered "Preview" (vs. code-only). */
export function artifactHasPreview(type: ArtifactType): boolean {
  return type !== "code";
}

/** What an artifact tool call did to an artifact. */
export type ArtifactCommand = "create" | "update" | "rewrite";

/**
 * Canonical artifact tool names. Shared so the tool definitions (agent side),
 * the /api/chat route (which intercepts these calls to persist + stream), and
 * the client all agree on the exact strings.
 */
export const ARTIFACT_TOOL_NAMES = {
  create: "create_artifact",
  update: "update_artifact",
  rewrite: "rewrite_artifact",
} as const;

/** True if `name` is one of the artifact tool names. */
export function isArtifactToolName(name: string): boolean {
  return (
    name === ARTIFACT_TOOL_NAMES.create ||
    name === ARTIFACT_TOOL_NAMES.update ||
    name === ARTIFACT_TOOL_NAMES.rewrite
  );
}

/** One immutable version of an artifact. */
export interface ArtifactVersion {
  /** 1-based version number; increments on every create/update/rewrite. */
  version: number;
  /** Full content snapshot at this version. */
  content: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/** A full artifact with its complete version history (oldest first). */
export interface Artifact {
  id: string;
  conversationId: string;
  /** Model-provided stable slug, unique within the conversation. */
  identifier: string;
  type: ArtifactType;
  title: string;
  /** Language hint for "code" artifacts (e.g. "python"); absent otherwise. */
  language?: string;
  versions: ArtifactVersion[];
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp of the latest version. */
  updatedAt: string;
}

/** An artifact shown in the user's cross-conversation artifact library. */
export interface ArtifactLibraryItem extends Artifact {
  /** Title of the conversation that owns this artifact. */
  conversationTitle: string;
}

/**
 * Lightweight reference recorded on the assistant message that created/updated
 * an artifact, used to render an inline chip that opens the panel.
 */
export interface ArtifactRef {
  artifactId: string;
  identifier: string;
  title: string;
  type: ArtifactType;
  /** The version number this message produced. */
  version: number;
  /** What this message did to the artifact. */
  command: ArtifactCommand;
}

/**
 * The payload of an `artifact` stream event: the full snapshot of the new
 * version, enough for the client to open the panel and render it immediately.
 */
export interface ArtifactSnapshot {
  id: string;
  identifier: string;
  type: ArtifactType;
  title: string;
  language?: string;
  /** The new/current version number. */
  version: number;
  /** Full content of this version. */
  content: string;
  /** The assistant message that produced this version. */
  messageId: string;
  /** ISO 8601 timestamp of the artifact's creation. */
  createdAt: string;
  /** ISO 8601 timestamp of this version. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Sites (Sites-style publishable web pages)
// ---------------------------------------------------------------------------

/**
 * The content kinds a Site can render. This is the artifact preview set MINUS
 * "code" (a Site is a rendered page, not source). `image` is reachable only via
 * publish-from-artifact; the model builds sites with SITE_BUILDABLE_TYPES.
 */
export type SiteType = "html" | "markdown" | "svg" | "image" | "mermaid" | "react";

/** All site content types, in display order. */
export const SITE_TYPES: SiteType[] = [
  "html",
  "markdown",
  "svg",
  "image",
  "mermaid",
  "react",
];

/** True if `v` is a valid SiteType. */
export function isSiteType(v: unknown): v is SiteType {
  return typeof v === "string" && (SITE_TYPES as string[]).includes(v);
}

/** Site types the model can build via `create_site` (image is publish-only). */
export const SITE_BUILDABLE_TYPES = [
  "html",
  "react",
  "markdown",
  "svg",
  "mermaid",
] as const;

/** Who can visit a deployed Site. `workspace` serving is deferred (v1: private+link). */
export type SiteVisibility = "private" | "link" | "workspace";

/** All visibility levels, in escalating-openness order. */
export const SITE_VISIBILITIES: SiteVisibility[] = ["private", "link", "workspace"];

/**
 * Derived lifecycle status of a Site:
 *  - "draft"          — never deployed (no live URL yet)
 *  - "deployed"       — live, and the live version matches the current draft
 *  - "deployed-stale" — live, but the draft has changed since the deploy
 *                       ("You have undeployed changes")
 */
export type SiteStatus = "draft" | "deployed" | "deployed-stale";

/** What a site tool call did. */
export type SiteCommand = "create" | "update" | "deploy";

/**
 * Canonical site tool names. Shared so the tool definitions, the /api/chat
 * route (which intercepts these calls), and the client all agree on the strings.
 */
export const SITE_TOOL_NAMES = {
  create: "create_site",
  update: "update_site",
  deploy: "deploy_site",
} as const;

/** True if `name` is one of the site tool names. */
export function isSiteToolName(name: string): boolean {
  return (
    name === SITE_TOOL_NAMES.create ||
    name === SITE_TOOL_NAMES.update ||
    name === SITE_TOOL_NAMES.deploy
  );
}

/** The same-origin public path for a Site's live page, e.g. "/s/my-site-ab12cd". */
export function sitePublicPath(slug: string): string {
  return `/s/${slug}`;
}

/** One immutable saved version of a Site. */
export interface SiteVersionInfo {
  id: string;
  /** 1-based; increments on every Save-a-Version. */
  version: number;
  type: SiteType;
  title: string;
  /** sha256(content) prefix — the pseudo git commit. */
  commit: string;
  /** Optional human label. */
  label?: string;
  createdAt: string;
  /** True if this is the currently deployed (live) version. */
  isLive: boolean;
}

/** A Site in list/card form (no full draft content). */
export interface SiteSummary {
  id: string;
  slug: string;
  name: string;
  description?: string;
  visibility: SiteVisibility;
  status: SiteStatus;
  /** Path to the live public page, e.g. "/s/my-site-ab12cd". */
  publicPath: string;
  /** Type used to render the card thumbnail (live version's type, else draft). */
  previewType: SiteType;
  /** Content used to render the card thumbnail (live version, else draft). */
  previewContent: string;
  /** Language hint for the preview; usually absent. */
  previewLanguage?: string;
  /** Version number currently live, or null if never deployed. */
  liveVersion: number | null;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
  /** ISO 8601 timestamp of the last deploy, if any. */
  deployedAt?: string;
}

/** Full Site detail including the editable draft + version history. */
export interface SiteDetail extends SiteSummary {
  draftType: SiteType;
  draftContent: string;
  draftLanguage?: string;
  liveVersionId: string | null;
  versions: SiteVersionInfo[];
  /** "tool" | "artifact" | "manual". */
  sourceType: string;
  createdInConversationId?: string;
  sourceArtifactId?: string;
}

/**
 * Lightweight reference recorded on the assistant message that built/deployed a
 * Site, used to render an inline chip that opens the Sites UI.
 */
export interface SiteRef {
  siteId: string;
  slug: string;
  name: string;
  command: SiteCommand;
  /** True when this message deployed the site to its live URL. */
  deployed: boolean;
  publicPath: string;
}

/**
 * Payload of a `site` stream event: enough for the client to open/refresh the
 * in-chat Site panel and preview the current draft immediately.
 */
export interface SiteSnapshot {
  id: string;
  slug: string;
  name: string;
  description?: string;
  visibility: SiteVisibility;
  status: SiteStatus;
  command: SiteCommand;
  draftType: SiteType;
  draftContent: string;
  draftLanguage?: string;
  liveVersion: number | null;
  publicPath: string;
  /** True when the site currently has a live deployment. */
  deployed: boolean;
  updatedAt: string;
}

/**
 * Request body for POST /api/sites. Either seed from an existing artifact
 * (`fromArtifactId`) or provide `type` + `content` for a fresh site.
 */
export interface CreateSiteRequest {
  name?: string;
  /** Seed the site's draft from this artifact's latest version. */
  fromArtifactId?: string;
  /** For a fresh site: the content type. */
  type?: SiteType;
  content?: string;
  language?: string | null;
  description?: string | null;
  visibility?: SiteVisibility;
}

/** Request body for PATCH /api/sites/[id] — any subset of editable fields. */
export interface UpdateSiteRequest {
  name?: string;
  description?: string | null;
  visibility?: SiteVisibility;
  draftContent?: string;
  draftType?: SiteType;
  draftLanguage?: string | null;
}

/** Request body for POST /api/sites/[id]/versions. */
export interface SaveSiteVersionRequest {
  label?: string | null;
}

/** Request body for POST /api/sites/[id]/deploy. */
export interface DeploySiteRequest {
  /** Specific saved version to deploy; defaults to the current draft (snapshotted). */
  versionId?: string;
}

// ---------------------------------------------------------------------------
// Component prop contracts
// ---------------------------------------------------------------------------

/**
 * Props for the FileUpload component owned by the Files agent and consumed by
 * the Chat-UI composer. Import from "@/components/upload/FileUpload".
 */
export interface FileUploadProps {
  /** Called with the freshly uploaded attachments after a successful upload. */
  onUploaded: (attachments: Attachment[]) => void;
  /** When true the upload control is disabled (e.g. while streaming). */
  disabled?: boolean;
}

/** Props for the message composer (input bar) owned by the Chat-UI agent. */
export interface ComposerProps {
  /** Invoked when the user submits a message. */
  onSend: (message: string, attachments: Attachment[]) => void;
  /** True while a response is streaming; disables send and shows stop affordance. */
  isStreaming: boolean;
  /** Stop the current stream. */
  onStop: () => void;
  /** Disable the entire composer (e.g. unauthenticated). */
  disabled?: boolean;
  /** Placeholder text for the textarea. */
  placeholder?: string;
}

/** Props for an individual rendered chat message. */
export interface MessageItemProps {
  message: ChatMessage;
  /** True while this assistant message is actively streaming. */
  isStreaming?: boolean;
}

// ---------------------------------------------------------------------------
// Scheduled tasks (Claude-Desktop-style automations)
// ---------------------------------------------------------------------------

/** How a run was triggered. */
export type ScheduleTrigger = "cron" | "manual";

/** Lifecycle status of a single scheduled-task run. */
export type ScheduleRunStatus = "running" | "success" | "error";

/** One fire attempt of a Schedule, as returned over the API. */
export interface ScheduleRunSummary {
  id: string;
  status: ScheduleRunStatus;
  trigger: ScheduleTrigger;
  /** The conversation this run produced (null until created / on early failure). */
  conversationId: string | null;
  /** Failure message when status is "error". */
  error: string | null;
  /** ISO 8601 timestamp. */
  startedAt: string;
  /** ISO 8601 timestamp; null while still running. */
  finishedAt: string | null;
}

/** A scheduled task as returned by the list/detail endpoints. */
export interface ScheduleSummary {
  id: string;
  title: string;
  /** The task instruction sent as the seed user message at each fire. */
  prompt: string;
  model: string;
  effort: ReasoningEffort;
  /** 5-field cron expression (minute hour day-of-month month day-of-week). */
  cron: string;
  /** IANA time zone the cron is evaluated in, e.g. "America/New_York". */
  timezone: string;
  enabled: boolean;
  /** Human-readable summary of `cron` (e.g. "At 09:00 AM, Monday through Friday"). */
  description: string;
  /** ISO 8601 next fire time (UTC); null when disabled or uncomputable. */
  nextRunAt: string | null;
  /** ISO 8601 last claim time (UTC); null if never run. */
  lastRunAt: string | null;
  /** Most recent run, for at-a-glance status; null if never run. */
  lastRun: ScheduleRunSummary | null;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

/** A scheduled task plus its recent run history (GET /api/schedules/[id]). */
export interface ScheduleDetail extends ScheduleSummary {
  /** Recent runs, newest first (capped by the endpoint). */
  runs: ScheduleRunSummary[];
}

/** Request body for POST /api/schedules. */
export interface CreateScheduleRequest {
  title: string;
  /** The task instruction. Required, non-empty. */
  prompt: string;
  /** 5-field cron expression. Validated server-side; invalid values are 400. */
  cron: string;
  /** IANA time zone; defaults to "UTC". */
  timezone?: string;
  /** Model id (one of MODELS[].id); defaults to DEFAULT_MODEL. */
  model?: string;
  /** Reasoning effort; defaults to DEFAULT_EFFORT. */
  effort?: ReasoningEffort;
  /** Whether the schedule is active; defaults to true. */
  enabled?: boolean;
}

/** Request body for PATCH /api/schedules/[id]. All fields optional (edit-in-place). */
export interface UpdateScheduleRequest {
  title?: string;
  prompt?: string;
  cron?: string;
  timezone?: string;
  model?: string;
  effort?: ReasoningEffort;
  enabled?: boolean;
}

/**
 * Response from GET /api/schedules/preview?cron=..&tz=.. — used by the form to
 * show a live plain-English summary + next fire times as the user edits.
 */
export interface CronPreviewResponse {
  valid: boolean;
  /** cronstrue summary when valid; an error hint when invalid. */
  description: string;
  /** Up to N upcoming ISO 8601 fire times (UTC), empty when invalid. */
  nextRuns: string[];
  /** Error message when `valid` is false. */
  error?: string;
}

/** Result of POST /api/cron (the external trigger). */
export interface CronTriggerResult {
  /** Number of schedules whose runs were started this tick. */
  started: number;
  /** ISO 8601 timestamp the tick ran at. */
  at: string;
}

// ---------------------------------------------------------------------------
// Projects (workspaces)
// ---------------------------------------------------------------------------

/** Semantic icon choices offered when creating or editing a project. */
export const PROJECT_ICON_NAMES = [
  "folder",
  "briefcase",
  "code",
  "book",
  "graduation",
  "lightbulb",
  "rocket",
  "palette",
  "chart",
  "heart",
] as const;

export type ProjectIconName = (typeof PROJECT_ICON_NAMES)[number];

export function isProjectIconName(value: unknown): value is ProjectIconName {
  return typeof value === "string" && (PROJECT_ICON_NAMES as readonly string[]).includes(value);
}

/**
 * A Project groups conversations around a shared purpose. Its custom
 * `instructions` and attached knowledge files are injected into the system
 * prompt for every chat in the project.
 */
export interface ProjectSummary {
  id: string;
  name: string;
  /** User-selected semantic project icon. */
  icon: ProjectIconName;
  /** Optional short summary shown on the project card; null when unset. */
  description: string | null;
  /** Custom instructions injected into every chat's system prompt; null when unset. */
  instructions: string | null;
  /** Number of conversations currently in this project. */
  conversationCount: number;
  /** Number of knowledge files attached to this project. */
  fileCount: number;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

/** One knowledge file attached to a project, as returned over the API. */
export interface ProjectFileInfo {
  id: string;
  /** Original filename. */
  name: string;
  /** MIME type. */
  type: string;
  /** Size in bytes. */
  size: number;
  /** Public URL to fetch the raw file (e.g. "/uploads/<id>.pdf"). */
  url: string;
  /**
   * True when readable text was extracted from the file and is therefore fed to
   * the model as knowledge. False when the type is unsupported or extraction
   * failed — the file is still listed but not part of the prompt context.
   */
  hasContent: boolean;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/** A project plus its knowledge files and member conversations. */
export interface ProjectDetail extends ProjectSummary {
  /** Knowledge files attached to the project, newest first. */
  files: ProjectFileInfo[];
  /** Conversations in this project, most recently updated first. */
  conversations: ConversationSummary[];
}

/** Request body for POST /api/projects. */
export interface CreateProjectRequest {
  /** Project name. Required, non-empty. */
  name: string;
  /** Optional semantic project icon; defaults to folder. */
  icon?: ProjectIconName;
  /** Optional short description. */
  description?: string;
  /** Optional custom instructions. */
  instructions?: string;
}

/** Request body for PATCH /api/projects/[id]. All fields optional (edit-in-place). */
export interface UpdateProjectRequest {
  name?: string;
  icon?: ProjectIconName;
  description?: string | null;
  instructions?: string | null;
}

/** Response body for POST /api/projects/[id]/files. */
export interface UploadProjectFilesResponse {
  files: ProjectFileInfo[];
}

/** Max number of knowledge files allowed per project. */
export const MAX_PROJECT_FILES = 20;

/**
 * Hard cap on total knowledge characters composed into the system prompt across
 * all of a project's files, to keep the context window bounded. Extraction may
 * store more per file; the prompt composer truncates to this budget.
 */
export const MAX_PROJECT_KNOWLEDGE_CHARS = 100_000;

// ---------------------------------------------------------------------------
// User settings & profile (Settings)
// ---------------------------------------------------------------------------

/**
 * Global custom instructions ("Customize OpenAgent"). When `enabled`, these are
 * composed into the system prompt for every chat (see src/lib/user/prompt.ts).
 */
export interface CustomInstructions {
  /** "What should OpenAgent call you?" */
  nickname: string;
  /** "What do you do?" */
  occupation: string;
  /** "What traits should OpenAgent have?" */
  traits: string;
  /** "Anything else OpenAgent should know?" */
  about: string;
  /** "Enable for new chats". */
  enabled: boolean;
}

export const EMPTY_CUSTOM_INSTRUCTIONS: CustomInstructions = {
  nickname: "",
  occupation: "",
  traits: "",
  about: "",
  enabled: true,
};

/** The signed-in user's profile + settings, returned by GET /api/user. */
export interface UserProfile {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  customInstructions: CustomInstructions;
}

/** Request body for PATCH /api/user. */
export interface UpdateUserRequest {
  name?: string;
  customInstructions?: CustomInstructions;
}

// ---------------------------------------------------------------------------
// Claude plugins & skills
// ---------------------------------------------------------------------------

/** How a plugin was obtained. */
export type PluginSourceType = "git" | "local";

/**
 * One skill discovered inside a plugin (a `skills/<name>/SKILL.md`, or a
 * single-skill plugin's root SKILL.md). Persisted as JSON in
 * `Plugin.skillsCache` — mirrors how McpServer caches its tool list — so
 * per-skill enable/disable is a JSON mutation with no second table.
 *
 * Only `name` + `description` are ever placed in the system prompt (progressive
 * disclosure); `dir` is the skill's directory RELATIVE to the plugin install
 * root and is used by the `skill` tool to read the full SKILL.md body and any
 * bundled resource files on demand.
 */
export interface PluginSkill {
  /** Skill invocation name (SKILL.md frontmatter `name`, else the dir name). */
  name: string;
  /** What the skill does AND when to use it — the sole selection signal. */
  description: string;
  /** Skill directory relative to the plugin install root (e.g. "skills/pdf"). */
  dir: string;
  /** When false, the skill is hidden from the prompt and the `skill` tool. */
  enabled: boolean;
  /**
   * SKILL.md `user-invocable` (default true). When false the skill is Claude-
   * only — hidden from the `/` slash menu and not user-invocable — but the model
   * may still load it automatically. Optional for back-compat (absent ⇒ true).
   */
  userInvocable?: boolean;
  /**
   * The inverse of SKILL.md `disable-model-invocation` (default false → true
   * here). When false the model never auto-loads the skill (kept out of the
   * "Available skills" prompt block) — it only runs when the user types
   * `/name`. Optional for back-compat (absent ⇒ true).
   */
  modelInvocable?: boolean;
  /** SKILL.md `argument-hint` (e.g. "[issue-number]"), shown in the `/` menu. */
  argumentHint?: string;
}

/**
 * Sanitized plugin shape returned by the /api/plugins routes. Never exposes the
 * on-disk install path.
 */
export interface PluginDTO {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  sourceType: PluginSourceType;
  /** Git URL or local path the user entered. */
  sourceUrl: string;
  /** Git ref (branch/tag/commit) for a git source. */
  gitRef?: string;
  /** Marketplace name when this plugin came from a marketplace repo. */
  marketplace?: string;
  enabled: boolean;
  skills: PluginSkill[];
  /** Count of bundled MCP servers registered into the Connectors subsystem. */
  mcpServerCount: number;
  /** Install/parse warnings (e.g. skipped stdio MCP servers, skill errors). */
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/plugins body — install a plugin from a git repo or local folder. */
export interface InstallPluginRequest {
  sourceType: PluginSourceType;
  /** Git URL (https) or an absolute/relative local folder path. */
  source: string;
  /** Optional git ref (branch/tag/commit) for a git source. */
  ref?: string;
  /** Must be true — installing runs untrusted skill content in the prompt. */
  trusted: boolean;
}

/** POST /api/plugins response — a source may yield several plugins (marketplace). */
export interface InstallPluginResponse {
  plugins: PluginDTO[];
  /** Non-fatal notes surfaced to the user (skipped sources, unsupported MCP…). */
  warnings: string[];
}

/** PATCH /api/plugins/[id] body. */
export interface UpdatePluginRequest {
  enabled?: boolean;
}

/** PATCH /api/plugins/[id]/skills/[skill] body. */
export interface UpdateSkillRequest {
  enabled: boolean;
}

/**
 * One enabled skill, flattened across the user's enabled plugins — the payload
 * of GET /api/skills that backs the composer's `/` slash-command menu.
 */
export interface SkillListItem {
  name: string;
  description: string;
  /** The plugin that provides the skill (shown as a subtle source label). */
  plugin: string;
  /** SKILL.md `argument-hint`, shown after the command in the menu. */
  argumentHint?: string;
}

/**
 * Hard cap on total skill-metadata characters (name + description lines) placed
 * in the system prompt across ALL enabled skills, so a user with many plugins
 * can't blow the context window. The composer drops skills past this budget.
 */
export const MAX_SKILLS_PROMPT_CHARS = 20_000;

/** Cap on a SKILL.md body returned by the `skill` tool (level-2 disclosure). */
export const MAX_SKILL_BODY_BYTES = 64 * 1024;

/** Cap on a bundled resource file returned by the `skill` tool (level 3). */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
