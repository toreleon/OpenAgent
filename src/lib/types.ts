/**
 * Shared TypeScript types used across the entire ChatGPT clone.
 * Every agent imports the relevant symbols from "@/lib/types".
 */

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

/** A single chat message as used on the client and serialized over the API. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  attachments?: Attachment[];
  toolCalls?: ToolCallRecord[];
  /**
   * The model's reasoning summary text (assistant messages only). Accumulated
   * from `reasoning_delta` stream events and persisted so the "Thinking" block
   * survives reloads. Absent when the model produced no reasoning summary.
   */
  reasoning?: string;
  /** How long the model spent producing the reasoning summary, in milliseconds. */
  reasoningMs?: number;
  /**
   * Artifacts this (assistant) message created or updated, in call order. Used
   * to render inline "artifact chips" that open the artifact panel. Absent when
   * the message produced no artifacts.
   */
  artifactRefs?: ArtifactRef[];
  /** ISO 8601 timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Conversations & models
// ---------------------------------------------------------------------------

/** Lightweight conversation entry for the sidebar list. */
export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

/** Full conversation with its messages. */
export interface ConversationDetail extends ConversationSummary {
  /** ISO 8601 timestamp. */
  createdAt: string;
  messages: ChatMessage[];
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
 * ChatGPT-style tiers below (`low | medium | high`) plus `minimal`, which the
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
 * Reasoning-effort tiers shown in the picker, ChatGPT-style.
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
  | { type: "title"; title: string }
  /**
   * Emitted when the assistant creates/updates/rewrites an artifact (i.e. calls
   * one of the artifact tools). Carries the full new-version snapshot so the
   * client can open or refresh the artifact panel live. See CONTRACTS.md.
   */
  | { type: "artifact"; command: ArtifactCommand; artifact: ArtifactSnapshot }
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
   * Reasoning effort for this turn. Flows ChatRequest.effort -> streamChat ->
   * Agent modelSettings.providerData.reasoning. Defaults to DEFAULT_EFFORT when
   * omitted; the server coerces unsupported values to DEFAULT_EFFORT.
   */
  effort?: ReasoningEffort;
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
}

/** Request body for PATCH /api/conversations/[id]. */
export interface UpdateConversationRequest {
  title: string;
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
// MCP connectors (remote MCP servers, ChatGPT-style)
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
