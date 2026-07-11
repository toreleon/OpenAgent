import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { streamChat } from "@/lib/agent";
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
  type StreamEvent,
  type ToolCallRecord,
} from "@/lib/types";

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

  // ---- Resolve or create the conversation ----
  let conversationId: string;
  let isNewConversation = false;
  let conversationTitle: string;
  let conversationModel: string;

  if (body.conversationId) {
    const convo = await prisma.conversation.findFirst({
      where: { id: body.conversationId, userId },
      select: { id: true, title: true, model: true },
    });
    if (!convo) {
      return Response.json({ error: "Not found" } satisfies ApiError, {
        status: 404,
      });
    }
    conversationId = convo.id;
    conversationTitle = convo.title;
    conversationModel = convo.model;
  } else {
    const created = await prisma.conversation.create({
      data: { title: "New chat", model, userId },
      select: { id: true, title: true, model: true },
    });
    conversationId = created.id;
    conversationTitle = created.title;
    conversationModel = created.model;
    isNewConversation = true;
  }

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
    createdAt: m.createdAt.toISOString(),
  }));

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
      const artifactRefs: ArtifactRef[] = [];
      let toolSeq = 0;
      let sawError = false;

      // Captured before streaming so reasoning duration is measured from the
      // moment we start the run. Date.now() is allowed in app code.
      const startedAt = Date.now();

      const send = (event: StreamEvent) => {
        controller.enqueue(sse(event));
      };

      try {
        // 1) message_id near the start.
        send({ type: "message_id", id: assistantMessageId });

        // 2..4) stream agent output.
        for await (const event of streamChat({
          model: conversationModel,
          history,
          userMessage,
          effort,
          userId,
        })) {
          switch (event.type) {
            case "reasoning_delta":
              reasoning += event.text;
              send(event);
              break;
            case "reasoning_done":
              // Record the thinking duration once, when reasoning settles.
              if (reasoningMs === null) {
                reasoningMs = Date.now() - startedAt;
              }
              send(event);
              break;
            case "delta":
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
              toolCalls.push({
                id: `tool_${toolSeq++}`,
                name: event.name,
                args: event.args,
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

        // ---- Persist final assistant message + bump conversation ----
        await prisma.message.update({
          where: { id: assistantMessageId },
          data: {
            content: assembled,
            toolCalls: encodeJsonArray(toolCalls),
            reasoning: reasoning.length > 0 ? reasoning : null,
            reasoningMs,
            artifactRefs: encodeJsonArray(artifactRefs),
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
        // 6) error then close. Still try to persist whatever we assembled.
        try {
          await prisma.message.update({
            where: { id: assistantMessageId },
            data: {
              content: assembled,
              toolCalls: encodeJsonArray(toolCalls),
              reasoning: reasoning.length > 0 ? reasoning : null,
              reasoningMs,
              artifactRefs: encodeJsonArray(artifactRefs),
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
