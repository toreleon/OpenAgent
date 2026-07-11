/**
 * Deep Research orchestrator.
 *
 * Implements the two frozen entry points the chat route drives:
 *   - `streamClarifyingQuestions` — the first Deep Research turn: stream 2-3
 *     clarifying questions as a normal assistant message.
 *   - `streamDeepResearch` — the full pipeline for the follow-up turn: plan →
 *     search + fetch + analyze each source → stream a synthesized, cited report.
 *
 * Both are async generators of {@link StreamEvent} and NEVER throw: any failure is
 * surfaced as an `error` event (planning/analysis/synthesis use the tool-less
 * completion primitives, which already degrade gracefully). The route splices the
 * yielded `delta` / `reasoning_*` events into the SSE stream and renders the
 * `research_plan` / `research_activity` events in the collapsible activity block.
 */

import { runCompletion, streamCompletion } from "@/lib/agent";
import { webFetchTool, webSearchFunctionTool } from "@/lib/tools";
import type {
  ChatMessage,
  ReasoningEffort,
  ResearchActivity,
  ResearchActivityKind,
  ResearchActivityStatus,
  ResearchPlan,
  StreamEvent,
} from "@/lib/types";
import {
  ANALYZE_SYSTEM,
  buildSynthesisUser,
  CLARIFY_SYSTEM,
  PLANNER_SYSTEM,
  SYNTHESIS_SYSTEM,
  type SourceRef,
} from "./prompts";

// ---------------------------------------------------------------------------
// Depth constants (fixed "Standard" depth — no depth picker).
// ---------------------------------------------------------------------------

/** Most subtopics we investigate, regardless of how many the planner returns. */
const MAX_SUBTOPICS = 4;
/** Sources we attempt to read per subtopic. */
const SOURCES_PER_SUBTOPIC = 3;
/** Hard cap on total pages successfully read across the whole run. */
const MAX_TOTAL_SOURCES = 12;

// ---------------------------------------------------------------------------
// Parameter types (match the frozen signatures the route imports).
// ---------------------------------------------------------------------------

export interface ClarifyingQuestionsParams {
  query: string;
  history: ChatMessage[];
  model: string;
  effort?: ReasoningEffort;
}

export interface DeepResearchParams {
  /** The research brief: the original query plus any clarification answers. */
  brief: string;
  model: string;
  effort?: ReasoningEffort;
  /** Owning user (threaded for future persistence; not needed by the pipeline). */
  userId: string;
  /** Owning conversation (threaded for future persistence; not needed here). */
  conversationId: string;
}

// ---------------------------------------------------------------------------
// Tool result shapes (subset of the fields we consume).
// ---------------------------------------------------------------------------

interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

interface WebSearchOk {
  ok: true;
  query: string;
  provider: string;
  results: WebSearchResultItem[];
  note?: string;
}

type WebSearchResponse = WebSearchOk | { ok: false; error?: string };

interface WebFetchOk {
  ok: true;
  url: string;
  title?: string;
  content: string;
  truncated?: boolean;
}

type WebFetchResponse = WebFetchOk | { ok: false; error?: string; code?: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Invoke a function tool programmatically and return its parsed result. The
 * Agents SDK `invoke(runContext, inputJson)` runs the tool's `execute` and
 * returns its result — an object for our tools, though older builds returned a
 * JSON string, so we accept both. Never throws: any failure (bad JSON input,
 * network error, thrown tool) yields `{ ok: false }`.
 */
async function callTool<T>(
  tool: { invoke: unknown },
  args: Record<string, unknown>,
): Promise<T | { ok: false }> {
  try {
    const invoke = tool.invoke as (
      runContext: unknown,
      input: string,
    ) => Promise<unknown>;
    const raw = await invoke({}, JSON.stringify(args));
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object") return parsed as T;
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Build a `research_activity` stream event. */
function activityEvent(
  id: string,
  kind: ResearchActivityKind,
  title: string,
  status: ResearchActivityStatus,
  url?: string,
): StreamEvent {
  const activity: ResearchActivity = { id, kind, title, status };
  if (url) activity.url = url;
  return { type: "research_activity", activity };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse the planner's output into a {@link ResearchPlan}. Strips code fences and
 * surrounding prose, validates the shape, and falls back to a single "Overview"
 * subtopic driven by the raw brief on any failure.
 */
function parsePlan(raw: string, brief: string): ResearchPlan {
  const fallback: ResearchPlan = {
    title: brief.slice(0, 80),
    subtopics: [{ title: "Overview", queries: [brief] }],
  };

  if (!raw || !raw.trim()) return fallback;

  let text = raw.trim();
  // Strip a ```json … ``` (or plain ```) fence if the model added one.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  // Isolate the outermost JSON object in case of stray prose.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) text = text.slice(start, end + 1);

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return fallback;

    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const rawSubtopics = Array.isArray(parsed.subtopics) ? parsed.subtopics : [];

    const subtopics: ResearchPlan["subtopics"] = [];
    for (const entry of rawSubtopics) {
      if (!isRecord(entry)) continue;
      const subtitle =
        typeof entry.title === "string" ? entry.title.trim() : "";
      if (!subtitle) continue;
      const queries = Array.isArray(entry.queries)
        ? entry.queries.filter(
            (q): q is string => typeof q === "string" && q.trim().length > 0,
          )
        : [];
      subtopics.push({
        title: subtitle,
        queries: queries.length > 0 ? queries : [subtitle],
      });
    }

    if (subtopics.length === 0) return fallback;
    return { title: title || fallback.title, subtopics };
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// 1. Clarifying questions (first Deep Research turn)
// ---------------------------------------------------------------------------

/**
 * Stream 2-3 clarifying questions as a normal assistant message. Yields the same
 * `reasoning_*` / `delta` / `error` events as any completion, so the route can
 * treat the output exactly like a plain chat turn.
 */
export async function* streamClarifyingQuestions(
  p: ClarifyingQuestionsParams,
): AsyncIterable<StreamEvent> {
  yield* streamCompletion({
    system: CLARIFY_SYSTEM,
    user: p.query,
    model: p.model,
    effort: p.effort ?? "low",
  });
}

// ---------------------------------------------------------------------------
// 2. Full research pipeline (follow-up turn)
// ---------------------------------------------------------------------------

/**
 * Run the full Deep Research pipeline. Emission order:
 *   1. one `research_plan`
 *   2. per subtopic: a `search` activity (active → done), then per source a
 *      `source` activity (active → done|failed) and an `analyze` activity
 *   3. a `synthesize` activity (active), the streamed report (`reasoning_*` +
 *      `delta`), then the `synthesize` activity (done)
 *
 * Never throws: unexpected failures yield a single `error` event and return.
 */
export async function* streamDeepResearch(
  p: DeepResearchParams,
): AsyncIterable<StreamEvent> {
  try {
    // --- (a) PLAN ---------------------------------------------------------
    const { content: planText } = await runCompletion({
      system: PLANNER_SYSTEM,
      user: p.brief,
      model: p.model,
      effort: "low",
    });
    const plan = parsePlan(planText, p.brief);
    yield { type: "research_plan", plan };

    // --- (b) RESEARCH LOOP ------------------------------------------------
    const seenUrls = new Set<string>();
    const registry: SourceRef[] = [];
    const findings: string[] = [];
    let reads = 0;

    const subtopics = plan.subtopics.slice(0, MAX_SUBTOPICS);
    for (let i = 0; i < subtopics.length; i++) {
      if (reads >= MAX_TOTAL_SOURCES) break;

      const subtopic = subtopics[i];
      const query = (
        subtopic.queries[0] ||
        subtopic.title ||
        p.brief
      ).trim();

      const searchId = `search-${i}`;
      yield activityEvent(searchId, "search", query, "active");
      const search = await callTool<WebSearchResponse>(webSearchFunctionTool, {
        query,
        count: 5,
        allowed_domains: null,
        blocked_domains: null,
      });
      yield activityEvent(searchId, "search", query, "done");

      const results =
        search.ok && Array.isArray(search.results) ? search.results : [];

      // Take up to SOURCES_PER_SUBTOPIC results we haven't already fetched.
      const picked: WebSearchResultItem[] = [];
      for (const result of results) {
        if (picked.length >= SOURCES_PER_SUBTOPIC) break;
        if (!result || typeof result.url !== "string" || !result.url) continue;
        if (seenUrls.has(result.url)) continue;
        seenUrls.add(result.url);
        picked.push(result);
      }

      let analyzedThisSubtopic = false;
      for (const result of picked) {
        if (reads >= MAX_TOTAL_SOURCES) break;

        const url = result.url;
        const label = (result.title && result.title.trim()) || url;
        const sourceId = `src-${url}`;
        yield activityEvent(sourceId, "source", label, "active", url);

        const fetched = await callTool<WebFetchResponse>(webFetchTool, {
          url,
          prompt: null,
          maxChars: 6000,
          format: "markdown",
        });
        if (!fetched.ok) {
          yield activityEvent(sourceId, "source", label, "failed", url);
          continue;
        }
        yield activityEvent(sourceId, "source", label, "done", url);

        const index = registry.length + 1;
        const sourceTitle = (fetched.title && fetched.title.trim()) || label;
        registry.push({ index, title: sourceTitle, url });
        reads++;

        const { content: analysis } = await runCompletion({
          system: ANALYZE_SYSTEM(subtopic.title),
          user: fetched.content,
          model: p.model,
          effort: "low",
        });
        const cleaned = analysis.trim();
        if (cleaned) findings.push(`[${index}] ${cleaned}`);
        analyzedThisSubtopic = true;
      }

      if (analyzedThisSubtopic) {
        yield activityEvent(
          `analyze-${i}`,
          "analyze",
          `Analyzing ${subtopic.title}`,
          "done",
        );
      }
    }

    // --- (c) SYNTHESIZE ---------------------------------------------------
    yield activityEvent("synth", "synthesize", "Writing report", "active");
    for await (const event of streamCompletion({
      system: SYNTHESIS_SYSTEM,
      user: buildSynthesisUser(p.brief, plan, registry, findings),
      model: p.model,
      effort: p.effort ?? "medium",
    })) {
      yield event;
    }
    yield activityEvent("synth", "synthesize", "Writing report", "done");
  } catch (err) {
    yield {
      type: "error",
      message:
        err instanceof Error
          ? err.message
          : "Deep research failed unexpectedly.",
    };
    return;
  }
}
