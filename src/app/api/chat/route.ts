import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { streamChat } from "@/lib/agent";
import {
  streamClarifyingQuestions,
  streamDeepResearch,
} from "@/lib/research/orchestrator";
import { loadProjectContext } from "@/lib/projects/prompt";
import {
  applyArtifactCommand,
  toolNameToArtifactCommand,
} from "@/lib/artifacts";
import {
  MODELS,
  DEFAULT_MODEL,
  REASONING_EFFORTS,
  DEFAULT_EFFORT,
  isArtifactToolName,
  type ApiError,
  type ArtifactRef,
  type Attachment,
  type ChatMessage,
  type ChatRequest,
  type ChatRole,
  type ReasoningEffort,
  type ResearchActivity,
  type ResearchPlan,
  type ResearchState,
  type StreamEvent,
  type ToolCallRecord,
  type TraceItem,
} from "@/lib/types";
import { extractToolArg } from "@/lib/toolActivity";

export const runtime = "nodejs";

const encoder = new TextEncoder();
function sse(event: StreamEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/** Decode a JSON-string DB column into a typed array, tolerating bad data. */
function decodeJsonArray<T>(value: string | null): T[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as T[];
    return undefined;
  } catch {
    return undefined;
  }
}

/** Stringify an array for storage, or null when empty/absent. */
function encodeJsonArray(value: unknown[] | undefined): string | null {
  if (!value || value.length === 0) return null;
  return JSON.stringify(value);
}

/**
 * Before persisting, mark any tool row still "running" as "error": the stream
 * ended (via failure, or an error event that skipped the tool's result) without
 * that tool completing, so it should rehydrate as failed rather than a spinner
 * that never resolves on reload.
 */
function finalizeTimeline(timeline: TraceItem[]): void {
  for (const it of timeline) {
    if (it.type === "tool" && it.status === "running") it.status = "error";
  }
}

/** Decode the JSON-string `research` column into ResearchState, tolerating bad data. */
function decodeResearch(value: string | null): ResearchState | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object") return parsed as ResearchState;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Build a short, clean title from the first user message. */
function deriveTitle(message: string): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New chat";
  const max = 60;
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max).replace(/\s+\S*$/, "").trim() + "…";
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }
  const userId = session.user.id;

  // ---- Parse & validate body ----
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" } satisfies ApiError, {
      status: 400,
    });
  }

  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) {
    return Response.json(
      { error: "message is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  // The effective model is resolved server-side (OPENAI_MODEL in .env wins, see
  // src/lib/agent.ts), so we never reject an unknown/stale client model — that
  // would 400 conversations saved with an older model id. Just normalize to a
  // known id for storage, falling back to the default.
  const model =
    typeof body.model === "string" && MODELS.some((m) => m.id === body.model)
      ? body.model
      : DEFAULT_MODEL;

  const attachments: Attachment[] = Array.isArray(body.attachments)
    ? body.attachments
    : [];

  // Reasoning effort: accept only values the effective model supports; coerce
  // anything else (including the SDK-allowed-but-rejected "minimal") to the
  // default. We never 400 on effort — see CONTRACTS.md §9.
  const effort: ReasoningEffort =
    typeof body.effort === "string" &&
    REASONING_EFFORTS.some((e) => e.id === body.effort && e.supported)
      ? (body.effort as ReasoningEffort)
      : DEFAULT_EFFORT;

  // Deep Research mode: when true, this turn either asks clarifying questions
  // (first research turn) or runs the full research pipeline (the turn that
  // answers them). The phase is derived from history below.
  const deepResearch = body.deepResearch === true;

  // ---- Resolve or create the conversation ----
  let conversationId: string;
  let isNewConversation = false;
  let conversationTitle: string;
  let conversationModel: string;
  let conversationProjectId: string | null;

  if (body.conversationId) {
    const convo = await prisma.conversation.findFirst({
      where: { id: body.conversationId, userId },
      select: { id: true, title: true, model: true, projectId: true },
    });
    if (!convo) {
      return Response.json({ error: "Not found" } satisfies ApiError, {
        status: 404,
      });
    }
    conversationId = convo.id;
    conversationTitle = convo.title;
    conversationModel = convo.model;
    conversationProjectId = convo.projectId;
  } else {
    // New conversation: honor an optional projectId, but only when it names a
    // project this user owns. An unknown/unowned id is silently ignored so a
    // stale client can never attach a chat to someone else's project.
    let projectId: string | null = null;
    if (typeof body.projectId === "string" && body.projectId) {
      const project = await prisma.project.findFirst({
        where: { id: body.projectId, userId },
        select: { id: true },
      });
      projectId = project?.id ?? null;
    }
    const created = await prisma.conversation.create({
      data: { title: "New chat", model, userId, projectId },
      select: { id: true, title: true, model: true, projectId: true },
    });
    conversationId = created.id;
    conversationTitle = created.title;
    conversationModel = created.model;
    conversationProjectId = created.projectId;
    isNewConversation = true;
  }

  // Project-scoped conversations inject the project's custom instructions +
  // knowledge into the system prompt. Never throws (degrades to no context).
  const projectContext =
    (await loadProjectContext(prisma, conversationProjectId)) ?? undefined;

  // ---- Load prior history (before persisting the new user turn) ----
  const priorMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
  });

  const history: ChatMessage[] = priorMessages.map((m) => ({
    id: m.id,
    role: m.role as ChatRole,
    content: m.content,
    attachments: decodeJsonArray<Attachment>(m.attachments),
    toolCalls: decodeJsonArray<ToolCallRecord>(m.toolCalls),
    research: decodeResearch(m.research),
    createdAt: m.createdAt.toISOString(),
  }));

  // ---- Deep Research phase detection ----
  // Look at the most recent assistant turn: if it asked clarifying questions,
  // this turn (the user's answers) runs the full research pipeline; otherwise a
  // fresh Deep Research turn asks the clarifying questions first.
  const lastAssistant = [...history]
    .reverse()
    .find((m) => m.role === "assistant");
  const isResearchPhase =
    deepResearch && lastAssistant?.research?.phase === "clarifying";

  // Determine if we should auto-title: only on the first exchange of a convo
  // that still carries the default title.
  const shouldTitle =
    (isNewConversation || conversationTitle === "New chat") &&
    history.length === 0;

  // ---- Persist the user message ----
  const userRecord = await prisma.message.create({
    data: {
      conversationId,
      role: "user",
      content: message,
      attachments: encodeJsonArray(attachments),
      toolCalls: null,
    },
  });

  const userMessage: ChatMessage = {
    id: userRecord.id,
    role: "user",
    content: message,
    attachments: attachments.length ? attachments : undefined,
    createdAt: userRecord.createdAt.toISOString(),
  };

  // Pre-create the assistant message row so we can stream its id immediately
  // and update it on completion.
  const assistantRecord = await prisma.message.create({
    data: {
      conversationId,
      role: "assistant",
      content: "",
      attachments: null,
      toolCalls: null,
    },
  });
  const assistantMessageId = assistantRecord.id;

  const newTitle = shouldTitle ? deriveTitle(message) : null;

  // ---- Build the SSE stream ----
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let assembled = "";
      let reasoning = "";
      let reasoningMs: number | null = null;
      const toolCalls: ToolCallRecord[] = [];
      // Ordered interleaved thinking trace (reasoning segments + tool rows),
      // persisted as `timeline` so it rehydrates in original order after reload.
      const timeline: TraceItem[] = [];
      const artifactRefs: ArtifactRef[] = [];
      let toolSeq = 0;
      let sawError = false;
      // True once an artifact command was ATTEMPTED (even if it failed), so the
      // empty-reply retry doesn't misread a failed artifact turn as "nothing
      // happened" and re-run (which would just re-attempt the failing artifact).
      let artifactAttempted = false;
      // JSON-encoded ResearchState for Deep Research turns; null for normal chat.
      let researchColumn: string | null = null;

      // Captured before streaming so reasoning duration is measured from the
      // moment we start the run. Date.now() is allowed in app code.
      const startedAt = Date.now();

      const send = (event: StreamEvent) => {
        controller.enqueue(sse(event));
      };

      try {
        // 1) message_id near the start.
        send({ type: "message_id", id: assistantMessageId });

        // 2..4) stream agent output. Deep Research branches into its own
        // pipeline (clarify questions, then the full research + report); normal
        // turns keep the existing tool-enabled agent path unchanged.
        if (deepResearch && isResearchPhase) {
          // RESEARCH phase: reconstruct the brief from the clarifying turn's
          // stored brief (fallback: the last user message before it), then run
          // the full research pipeline and stream the report inline.
          let originalQuery = lastAssistant?.research?.brief ?? "";
          if (!originalQuery && lastAssistant) {
            const idx = history.indexOf(lastAssistant);
            for (let i = idx - 1; i >= 0; i--) {
              if (history[i].role === "user") {
                originalQuery = history[i].content;
                break;
              }
            }
          }
          const brief =
            "Research topic:\n" +
            originalQuery +
            "\n\nUser clarifications:\n" +
            message;

          let researchPlan: ResearchPlan | undefined;
          const researchActivities: ResearchActivity[] = [];

          for await (const event of streamDeepResearch({
            brief,
            model: conversationModel,
            effort,
            userId,
            conversationId,
          })) {
            switch (event.type) {
              case "research_plan":
                researchPlan = event.plan;
                send(event);
                break;
              case "research_activity": {
                // Upsert by stable id: a finishing search/source replaces its
                // in-progress entry rather than appending a duplicate.
                const idx = researchActivities.findIndex(
                  (a) => a.id === event.activity.id,
                );
                if (idx >= 0) researchActivities[idx] = event.activity;
                else researchActivities.push(event.activity);
                send(event);
                break;
              }
              case "reasoning_delta":
                reasoning += event.text;
                send(event);
                break;
              case "reasoning_done":
                if (reasoningMs === null) {
                  reasoningMs = Date.now() - startedAt;
                }
                send(event);
                break;
              case "delta":
                assembled += event.text;
                send(event);
                break;
              case "error":
                sawError = true;
                send(event);
                break;
              default:
                break;
            }
          }

          const sourceCount = researchActivities.filter(
            (a) => a.kind === "source" && a.status === "done",
          ).length;
          researchColumn = JSON.stringify({
            phase: "report",
            brief,
            plan: researchPlan,
            activities: researchActivities,
            sourceCount,
          } satisfies ResearchState);
        } else if (deepResearch) {
          // CLARIFY phase (first Deep Research turn): ask 2-3 clarifying
          // questions as a normal streamed assistant message. The next turn
          // (the user's answers) runs the RESEARCH phase above.
          for await (const event of streamClarifyingQuestions({
            query: message,
            history,
            model: conversationModel,
            effort,
          })) {
            switch (event.type) {
              case "reasoning_delta":
                reasoning += event.text;
                send(event);
                break;
              case "reasoning_done":
                if (reasoningMs === null) {
                  reasoningMs = Date.now() - startedAt;
                }
                send(event);
                break;
              case "delta":
                assembled += event.text;
                send(event);
                break;
              case "error":
                sawError = true;
                send(event);
                break;
              default:
                break;
            }
          }
          researchColumn = JSON.stringify({
            phase: "clarifying",
            brief: message,
          } satisfies ResearchState);
        } else {
        // Consume one streamChat run into the accumulators. Factored out so we
        // can re-run it once if the first attempt produces nothing (see below).
        // `suppressReasoning` hides the retry's Thinking events so the user
        // doesn't see a second, doubled reasoning block.
        const consumeChat = async (suppressReasoning: boolean) => {
        for await (const event of streamChat({
          model: conversationModel,
          conversationId,
          history,
          userMessage,
          effort,
          userId,
          projectContext,
        })) {
          switch (event.type) {
            case "reasoning_delta": {
              if (suppressReasoning) break;
              reasoning += event.text;
              // Append to the open reasoning segment, or start a new one after a
              // tool row — preserving think → act → think order in the timeline.
              const last = timeline[timeline.length - 1];
              if (last && last.type === "reasoning") {
                last.text += event.text;
              } else {
                timeline.push({ type: "reasoning", text: event.text });
              }
              send(event);
              break;
            }
            case "reasoning_done":
              // Forwarded for the client, but NOT used to freeze the duration:
              // it fires after the first reasoning segment, which on interleaved
              // think→tool→think turns lands well before the answer. Freeze at
              // the first answer `delta` instead so tool time is included.
              if (suppressReasoning) break;
              send(event);
              break;
            case "delta":
              // The answer has started: the thinking phase is over. Freeze the
              // total thinking duration (reasoning + any tool time) once.
              if (reasoningMs === null && (reasoning.length > 0 || timeline.length > 0)) {
                reasoningMs = Date.now() - startedAt;
              }
              assembled += event.text;
              send(event);
              break;
            case "tool_call": {
              // Artifact tool calls are intercepted here: instead of surfacing a
              // generic "tool" card, we persist the artifact + version and emit a
              // dedicated `artifact` event that drives the side panel. The model
              // still receives the tool's own ack as its function result.
              const command = toolNameToArtifactCommand(event.name);
              if (command) {
                artifactAttempted = true;
                try {
                  const result = await applyArtifactCommand(prisma, {
                    conversationId,
                    messageId: assistantMessageId,
                    command,
                    args: event.args,
                  });
                  if (result.ok) {
                    artifactRefs.push(result.ref);
                    send({
                      type: "artifact",
                      command,
                      artifact: result.snapshot,
                    });
                  } else {
                    console.error("[chat] artifact command failed:", result.error);
                  }
                } catch (err) {
                  console.error("[chat] artifact persistence error:", err);
                }
                break;
              }
              const recordId = `tool_${toolSeq++}`;
              toolCalls.push({
                id: recordId,
                name: event.name,
                args: event.args,
              });
              timeline.push({
                type: "tool",
                id: recordId,
                tool: event.name,
                arg: extractToolArg(event.name, event.args),
                status: "running",
              });
              send(event);
              break;
            }
            case "tool_result": {
              // Artifact tools have no visible "tool" card, so skip their results.
              if (isArtifactToolName(event.name)) break;
              // Attach output to the most recent matching call record.
              for (let i = toolCalls.length - 1; i >= 0; i--) {
                if (
                  toolCalls[i].name === event.name &&
                  toolCalls[i].output === undefined
                ) {
                  toolCalls[i].output = event.output;
                  break;
                }
              }
              // Flip the matching running tool row in the timeline to done.
              for (let i = timeline.length - 1; i >= 0; i--) {
                const it = timeline[i];
                if (it.type === "tool" && it.tool === event.name && it.status === "running") {
                  it.status = "done";
                  break;
                }
              }
              send(event);
              break;
            }
            case "error":
              sawError = true;
              send(event);
              break;
            // message_id/title/done are owned by this route; ignore if emitted.
            default:
              break;
          }
        }
        };

        // First attempt at the reply. If it produced literally nothing — no
        // answer text, no tool call, no artifact — and didn't error, the model
        // returned only a reasoning summary (an occasional reasoning-model quirk);
        // re-run ONCE (bounded) so the user gets a real answer, not a blank turn.
        await consumeChat(false);
        if (
          !sawError &&
          assembled.trim() === "" &&
          toolCalls.length === 0 &&
          artifactRefs.length === 0 &&
          !artifactAttempted
        ) {
          // Attempt 1 produced nothing meaningful; drop any stray whitespace it
          // streamed so the retry's answer is the sole persisted content.
          assembled = "";
          await consumeChat(true);
        }
        // Fallback: a turn that thought (reasoning and/or tools) but never
        // produced an answer delta still needs a frozen thinking duration.
        if (reasoningMs === null && (reasoning.length > 0 || timeline.length > 0)) {
          reasoningMs = Date.now() - startedAt;
        }
        }

        // ---- Persist final assistant message + bump conversation ----
        finalizeTimeline(timeline);
        await prisma.message.update({
          where: { id: assistantMessageId },
          data: {
            content: assembled,
            toolCalls: encodeJsonArray(toolCalls),
            timeline: encodeJsonArray(timeline),
            reasoning: reasoning.length > 0 ? reasoning : null,
            reasoningMs,
            artifactRefs: encodeJsonArray(artifactRefs),
            research: researchColumn,
          },
        });

        const convoData: { updatedAt: Date; title?: string } = {
          updatedAt: new Date(),
        };
        if (newTitle) convoData.title = newTitle;
        await prisma.conversation.update({
          where: { id: conversationId },
          data: convoData,
        });

        // 4) title event (after content is settled). Suppressed on error so we
        // honor the "error then close" ordering (no events after `error`).
        if (newTitle && !sawError) {
          send({ type: "title", title: newTitle });
        }

        // 5) terminal done (only on success).
        if (!sawError) {
          send({ type: "done" });
        }
      } catch (err) {
        // 6) error then close. Still try to persist whatever we assembled —
        // including the interleaved timeline (finalized so a tool that was
        // mid-flight when the run threw rehydrates as errored, not spinning).
        try {
          finalizeTimeline(timeline);
          await prisma.message.update({
            where: { id: assistantMessageId },
            data: {
              content: assembled,
              toolCalls: encodeJsonArray(toolCalls),
              timeline: encodeJsonArray(timeline),
              reasoning: reasoning.length > 0 ? reasoning : null,
              reasoningMs,
              artifactRefs: encodeJsonArray(artifactRefs),
              research: researchColumn,
            },
          });
          await prisma.conversation.update({
            where: { id: conversationId },
            data: { updatedAt: new Date() },
          });
        } catch {
          // best-effort persistence
        }
        send({
          type: "error",
          message:
            err instanceof Error
              ? err.message
              : "An unexpected error occurred while streaming the response.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Conversation-Id": conversationId,
    },
  });
}
