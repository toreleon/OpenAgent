/**
 * Parallel subagents (Claude-Desktop-style orchestrator → workers).
 *
 * The chat agent's `run_subagents` tool dispatches N independent subtasks; each
 * runs here as its OWN bounded, isolated agent turn with a READ-ONLY research
 * toolset — web search/fetch, compute, and read-only workspace tools. It
 * deliberately EXCLUDES the write/shell/artifact tools, MCP connectors, the
 * `skill` tool, and `run_subagents` itself, so:
 *   - there is no fork-bomb (a worker cannot spawn more workers), and
 *   - parallel workers never race as writers on the shared per-conversation
 *     workspace (reads are safe to run concurrently).
 *
 * Each worker returns a concise findings string; the tool digests them for the
 * lead agent to synthesize. Live progress is surfaced through an `onActivity`
 * callback that the tool wires to the parent SSE stream (see run-subagents.ts).
 *
 * NEVER throws: a worker that errors resolves to a failed {@link SubagentResult}
 * so one bad subagent cannot take down the batch — or the parent SSE stream.
 */

import {
  Agent,
  run,
  user,
  type RunStreamEvent,
  type Tool,
} from "@openai/agents";
import type { ReasoningEffort, SubagentActivity } from "@/lib/types";
import { DEFAULT_EFFORT } from "@/lib/types";
import { ensureApiKey, resolveModel } from "@/lib/openaiClient";
import { extractToolArg, toolActivityLabel } from "@/lib/toolActivity";
// Import each worker tool directly from its module (NOT from "@/lib/tools",
// whose index re-exports `run_subagents` → runner and would cycle).
import { webSearchFunctionTool } from "@/lib/tools/web-search";
import { webFetchTool } from "@/lib/tools/web-fetch";
import { runJavascriptTool } from "@/lib/tools/run-javascript";
import { getCurrentTimeTool } from "@/lib/tools/get-current-time";
import { readFileTool } from "@/lib/tools/read-file";
import { listDirTool } from "@/lib/tools/list-dir";
import { grepSearchTool } from "@/lib/tools/grep-search";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Hard cap on subagents dispatched in a single `run_subagents` call. */
export const MAX_SUBAGENTS = 6;
/** Max concurrent worker runs; the rest queue. Bounds model/search fan-out. */
const CONCURRENCY = 4;
/** Turn budget per worker: enough for a few search → read → synthesize cycles. */
const SUBAGENT_MAX_TURNS = 16;
/** Cap on a single worker's returned findings text (chars) fed to the digest. */
export const MAX_RESULT_CHARS = 6000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One subtask handed to a worker. */
export interface SubagentTask {
  /** Short label shown to the user (e.g. "React charting libraries"). */
  title: string;
  /** Self-contained instructions: what to investigate and what to report. */
  prompt: string;
}

/** The settled outcome of one worker. */
export interface SubagentResult {
  title: string;
  /** The worker's final findings text (may be empty when it failed). */
  result: string;
  /** How many tool calls the worker made. */
  steps: number;
  /** Error message when the worker failed; absent on success. */
  error?: string;
}

export interface RunSubagentsOptions {
  /** UI model id; each worker resolves the effective model itself. */
  model: string;
  effort?: ReasoningEffort;
  /** Threaded to the read-only workspace tools so a worker reads the same tree. */
  conversationId?: string;
  userId?: string;
  /**
   * Live progress sink. Called with a FULL {@link SubagentActivity} snapshot on
   * each status change (running → step notes → done|failed). Must never throw.
   */
  onActivity?: (activity: SubagentActivity) => void;
}

// ---------------------------------------------------------------------------
// Worker toolset + system prompt
// ---------------------------------------------------------------------------

/**
 * READ-ONLY research toolset for a worker. Excludes edit_file/write_file/
 * run_shell (no parallel writers on the shared workspace), the artifact + site
 * tools (only the lead agent produces deliverables), MCP servers, the `skill`
 * tool, and `run_subagents` (no recursion). Read-only workspace tools
 * (read_file/list_dir/grep_search) are safe to run concurrently.
 */
const subagentTools: Tool[] = [
  webSearchFunctionTool,
  webFetchTool,
  runJavascriptTool,
  getCurrentTimeTool,
  readFileTool,
  listDirTool,
  grepSearchTool,
];

const SUBAGENT_INSTRUCTIONS = `You are a focused research subagent working on ONE narrow subtask, dispatched by a lead agent that is handling a larger task.

- Investigate ONLY your assigned subtask. Do NOT try to answer the user's whole question or do work outside your subtask.
- You do NOT see the conversation — everything you need is in your subtask prompt. If something is ambiguous, make a reasonable assumption and note it.
- Use your tools to gather concrete evidence: web_search + web_fetch for current facts (prefer primary sources; keep source URLs), run_javascript for computation, and the read-only workspace tools read_file / list_dir / grep_search for code in the workspace.
- Be efficient: a few well-chosen tool calls, then STOP and report. You have a limited turn budget — do not loop.
- Your FINAL message is your report back to the lead agent (it is not shown directly to the user). Make it a concise, self-contained findings summary — key facts, figures, short quotes, and source URLs — that the lead agent can merge with other subagents' findings. Skip pleasantries and do not restate the task.
- You CANNOT create artifacts, write files, run shell commands, call skills, or dispatch further subagents. If your subtask would need those, describe what should be done and leave it to the lead agent.`;

// ---------------------------------------------------------------------------
// Small helpers (mirror the raw-item parsing in src/lib/agent.ts)
// ---------------------------------------------------------------------------

/** Safely read a string-ish field off an unknown raw item. */
function readString(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** Best-effort parse of a tool's argument string into a value. */
function parseArgs(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** First non-empty line of a report, trimmed to a compact one-liner. */
function firstLine(text: string, max = 140): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  const one = line.replace(/\s+/g, " ");
  return one.length > max ? one.slice(0, max - 1).trimEnd() + "…" : one;
}

// ---------------------------------------------------------------------------
// One worker
// ---------------------------------------------------------------------------

async function runOne(
  index: number,
  task: SubagentTask,
  opts: RunSubagentsOptions,
): Promise<SubagentResult> {
  const id = `sub-${index}`;
  const effort: ReasoningEffort = opts.effort ?? DEFAULT_EFFORT;
  let steps = 0;

  // Emit reads the live `steps` at call time (closures capture the binding).
  const emit = (status: SubagentActivity["status"], detail?: string) => {
    opts.onActivity?.({ id, title: task.title, status, steps, detail });
  };

  emit("running", "Starting…");

  if (!ensureApiKey()) {
    const error = "The server is missing OPENAI_API_KEY.";
    emit("failed", error);
    return { title: task.title, result: "", steps, error };
  }

  let agent: Agent;
  try {
    agent = new Agent({
      name: `Subagent ${index + 1}`,
      instructions: SUBAGENT_INSTRUCTIONS,
      model: resolveModel(opts.model),
      tools: subagentTools,
      modelSettings: {
        providerData: { reasoning: { effort, summary: "auto" } },
      },
    });
  } catch (err) {
    const error =
      err instanceof Error
        ? `Failed to initialize subagent: ${err.message}`
        : "Failed to initialize subagent.";
    emit("failed", error);
    return { title: task.title, result: "", steps, error };
  }

  const prompt = `Subtask: ${task.title}\n\n${task.prompt}`;
  let content = "";

  try {
    // A worker gets the workspace context (for its read-only file tools) but NOT
    // the `onEvent` side channel — its tool activity is captured here for the
    // step counter, never leaked into the parent SSE stream. With no
    // `run_subagents` in its toolset, a worker also cannot recurse.
    const streamed = await run(agent, [user(prompt)], {
      stream: true,
      maxTurns: SUBAGENT_MAX_TURNS,
      context: {
        conversationId: opts.conversationId,
        userId: opts.userId,
      },
    });

    // The SDK rejects `.completed` the instant the run fails (e.g. a worker that
    // loops until MaxTurnsExceededError). That rejection can land WHILE the
    // for-await loop below is still draining buffered events — i.e. before we
    // reach `await completed`. A rejected promise with no handler attached
    // triggers Node's `unhandledRejection`, which crashes the dev server. Capture
    // the promise once and attach an eager no-op catch so it is always "handled";
    // the `await completed` below still surfaces the real error to our catch.
    const completed = streamed.completed;
    completed.catch(() => {});

    for await (const event of streamed as AsyncIterable<RunStreamEvent>) {
      if (event.type === "raw_model_stream_event") {
        const data = event.data as { type?: string; delta?: unknown };
        if (
          data?.type === "output_text_delta" &&
          typeof data.delta === "string"
        ) {
          content += data.delta;
        }
        continue;
      }
      if (
        event.type === "run_item_stream_event" &&
        event.name === "tool_called"
      ) {
        const raw = (event.item as { rawItem?: unknown }).rawItem;
        const name =
          readString(raw, "name") ?? readString(event.item, "name") ?? "tool";
        const arg = extractToolArg(name, parseArgs(readString(raw, "arguments")));
        steps++;
        emit("running", toolActivityLabel(name, arg, "running"));
      }
    }

    await completed;
  } catch (err) {
    const error =
      err instanceof Error ? err.message : "The subagent failed to respond.";
    // Keep any partial content, but report the failure.
    emit("failed", error);
    return { title: task.title, result: content.trim(), steps, error };
  }

  const result = content.trim();
  if (!result) {
    const error = "The subagent produced no findings.";
    emit("failed", error);
    return { title: task.title, result: "", steps, error };
  }

  emit("done", firstLine(result));
  return { title: task.title, result: result.slice(0, MAX_RESULT_CHARS), steps };
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

/**
 * Run `tasks` as parallel workers (capped at {@link MAX_SUBAGENTS}, at most
 * {@link CONCURRENCY} at once). Emits an initial "queued" row for every task up
 * front so the whole batch appears in the panel immediately, then updates each
 * row live as its worker runs. Resolves with one {@link SubagentResult} per
 * task, in the original order. Never rejects.
 */
export async function runSubagentsBatch(
  tasks: SubagentTask[],
  opts: RunSubagentsOptions,
): Promise<SubagentResult[]> {
  const capped = tasks.slice(0, MAX_SUBAGENTS);
  if (capped.length === 0) return [];

  // Show the full batch immediately (workers past the concurrency limit are
  // genuinely queued until a slot frees).
  for (let i = 0; i < capped.length; i++) {
    opts.onActivity?.({
      id: `sub-${i}`,
      title: capped[i].title,
      status: "running",
      steps: 0,
      detail: "Queued…",
    });
  }

  const results: SubagentResult[] = new Array(capped.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= capped.length) return;
      results[i] = await runOne(i, capped[i], opts);
    }
  };

  const pool = Array.from({ length: Math.min(CONCURRENCY, capped.length) }, () =>
    worker(),
  );
  await Promise.all(pool);
  return results;
}
