import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { streamChat } from "@/lib/agent";
import { snapshotTurn, hasSnapshotStore } from "@/lib/workspace/snapshot";
import { setSnapshotSha } from "@/lib/workspace/checkpoints";
import {
  streamClarifyingQuestions,
  streamDeepResearch,
} from "@/lib/research/orchestrator";
import { loadProjectContext } from "@/lib/projects/prompt";
import { loadUserContext } from "@/lib/user/prompt";
import { loadSkillsContext, resolveSlashSkill } from "@/lib/plugins/context";
import { matchBuiltinCommand, DEEP_RESEARCH_COMMAND } from "@/lib/plugins/builtin";
import {
  applyArtifactCommand,
  toolNameToArtifactCommand,
} from "@/lib/artifacts";
import { applySiteCommand, toolNameToSiteCommand } from "@/lib/sites";
import {
  MODELS,
  DEFAULT_MODEL,
  REASONING_EFFORTS,
  DEFAULT_EFFORT,
  isArtifactToolName,
  isSiteToolName,
  isSubagentToolName,
  type ApiError,
  type ArtifactRef,
  type SiteRef,
  type Attachment,
  type ChatMessage,
  type ChatRequest,
  type ChatRole,
  type ReasoningEffort,
  type ResearchActivity,
  type ResearchPlan,
  type ResearchState,
  type StreamEvent,
  type SubagentActivity,
  type SubagentState,
  type BrowserActivity,
  type BrowserState,
  type ToolCallRecord,
  type TraceItem,
} from "@/lib/types";
import { extractToolArg } from "@/lib/toolActivity";
import { isBrowserToolName } from "@/lib/tools/browser";

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

/**
 * The short assistant message that accompanies a Deep Research report. The
 * report itself is delivered as a `markdown` artifact opened in the side panel,
 * so the chat bubble only introduces it and points the reader there.
 */
function buildReportLeadIn(title: string, sourceCount: number): string {
  const name = title.trim() || "your topic";
  if (sourceCount <= 0) {
    return `I've written up my research on **${name}** as a report — open the document in the panel to read it. Live web sources were unavailable, so it draws on general knowledge; please verify key facts independently.`;
  }
  const sources = sourceCount === 1 ? "1 source" : `${sourceCount} sources`;
  return `I've finished researching **${name}** and compiled the findings into a report drawing on ${sources}. Open the document in the panel to read the full write-up.`;
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

/** Decode the JSON-string `subagents` column into SubagentState, tolerating bad data. */
function decodeSubagents(value: string | null): SubagentState | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as SubagentState).agents) &&
      (parsed as SubagentState).agents.length > 0
    ) {
      return parsed as SubagentState;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Encode accumulated parallel-subagent activity for storage, or null when none ran. */
function encodeSubagents(agents: SubagentActivity[]): string | null {
  if (agents.length === 0) return null;
  return JSON.stringify({ agents } satisfies SubagentState);
}

/**
 * Before persisting, mark any subagent still "running" as "failed": the stream
 * ended before that worker reported a terminal status, so it should rehydrate as
 * failed rather than a spinner that never resolves on reload. Mirrors
 * {@link finalizeTimeline}.
 */
function finalizeSubagents(agents: SubagentActivity[]): void {
  const now = Date.now();
  for (const a of agents) {
    if (a.status !== "running") continue;
    a.status = "failed";
    // Bound the persisted duration and close any trailing in-flight trace step so
    // the working-view card rehydrates settled rather than mid-action.
    if (a.startedAt && a.endedAt === undefined) a.endedAt = now;
    if (a.trace) for (const s of a.trace) if (s.status === "running") s.status = "done";
  }
}

/** Encode accumulated browser-control activity for storage, or null when none ran.
 *  Drops the base64 screenshots: they are diagnostic-only + streamed live, and
 *  keeping rendered page pixels in the DB row bloats it and stores content at
 *  rest. The reloaded panel shows the action trace + page titles/timings. */
function encodeBrowser(activities: BrowserActivity[]): string | null {
  if (activities.length === 0) return null;
  // Setting thumbnailDataUrl to undefined drops the key entirely from JSON.
  const lean = activities.map((a) => ({ ...a, thumbnailDataUrl: undefined }));
  return JSON.stringify({ activities: lean } satisfies BrowserState);
}

/**
 * Before persisting, SETTLE any browsing card still "running": the stream ended,
 * so it should rehydrate as a finished card (browsing isn't a worker that
 * "failed"), with its timer frozen and any trailing in-flight step closed.
 */
function finalizeBrowser(activities: BrowserActivity[]): void {
  const now = Date.now();
  for (const a of activities) {
    if (a.status !== "running") continue;
    a.status = "done";
    if (a.startedAt && a.endedAt === undefined) a.endedAt = now;
    if (a.trace) for (const s of a.trace) if (s.status === "running") s.status = "done";
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

  // Branching: `regenerate` re-answers an existing user message (no new user
  // turn); `parentId` picks the branch this turn attaches under. `requestedParentId`
  // is undefined when omitted (server picks a default), null for an explicit root,
  // or a message id (validated against this conversation below).
  const isRegenerate = body.regenerate === true;
  // Distinguish an EXPLICIT null (root — e.g. editing the first user message)
  // from an omitted/invalid value (undefined → use the server default). A
  // non-empty string is a candidate parent id, validated against the tree below.
  const requestedParentId: string | null | undefined =
    body.parentId === null
      ? null
      : typeof body.parentId === "string" && body.parentId
        ? body.parentId
        : undefined;

  const rawMessage = typeof body?.message === "string" ? body.message.trim() : "";
  // A regenerate reuses an existing user turn's text (loaded from parentId
  // below), so it carries no message body; every other turn requires one.
  if (!isRegenerate && !rawMessage) {
    return Response.json(
      { error: "message is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  // Deep Research is a BUILT-IN command: a message that starts with
  // `/deep-research` triggers the research pipeline for this turn. When the
  // command carries a question we strip the command, so the question is what
  // gets persisted, searched, titled, and shown in the user bubble. (The legacy
  // `body.deepResearch` flag still works, and a clarify turn auto-continues to
  // the report phase below.)
  const builtin = isRegenerate ? null : matchBuiltinCommand(rawMessage);
  const isDeepResearchCommand = builtin?.command.name === DEEP_RESEARCH_COMMAND;
  if (isDeepResearchCommand && !builtin!.rest) {
    return Response.json(
      {
        error: "Deep Research needs a question — try /deep-research <your question>.",
      } satisfies ApiError,
      { status: 400 },
    );
  }
  // For a /deep-research command the argument IS the message (guaranteed
  // non-empty above); otherwise the raw message stands. Reassigned to the
  // re-answered user turn's text for a regenerate (see below).
  let message = isDeepResearchCommand ? builtin!.rest : rawMessage;

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
  // answers them). Triggered by the `/deep-research` built-in command or the
  // legacy body flag; also auto-continued after a clarify turn (see below).
  let deepResearch = body.deepResearch === true || isDeepResearchCommand;

  // ---- Resolve or create the conversation ----
  let conversationId: string;
  let isNewConversation = false;
  let conversationTitle: string;
  let conversationModel: string;
  let conversationProjectId: string | null;
  let conversationActiveLeafId: string | null;

  if (body.conversationId) {
    const convo = await prisma.conversation.findFirst({
      where: { id: body.conversationId, userId },
      select: {
        id: true,
        title: true,
        model: true,
        projectId: true,
        activeLeafId: true,
      },
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
    conversationActiveLeafId = convo.activeLeafId;
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
      select: {
        id: true,
        title: true,
        model: true,
        projectId: true,
        activeLeafId: true,
      },
    });
    conversationId = created.id;
    conversationTitle = created.title;
    conversationModel = created.model;
    conversationProjectId = created.projectId;
    conversationActiveLeafId = created.activeLeafId;
    isNewConversation = true;
  }

  // System-prompt context: the user's global custom instructions ("Customize
  // OpenAgent") plus, for project-scoped chats, the project's instructions +
  // knowledge. Both degrade to nothing on error; combined into one block passed
  // as `projectContext` so no agent-signature change is needed.
  const userContext = await loadUserContext(prisma, userId);
  const projContext = await loadProjectContext(prisma, conversationProjectId);
  const projectContext =
    [userContext, projContext].filter(Boolean).join("\n\n") || undefined;

  // Installed plugin skills: only each enabled skill's name + description goes
  // into the prompt (progressive disclosure); the model pulls a skill's full
  // body on demand via the `skill` tool. Degrades to undefined on error.
  const baseSkillsContext = (await loadSkillsContext(userId)) || undefined;

  // Explicit skill invocation: a message that starts with `/<skill-name>` (a
  // slash command from the composer menu) forces that skill for this turn. We
  // validate the command names one of the user's enabled skills, then append a
  // directive so the model loads it via the `skill` tool. An ordinary message
  // that merely starts with "/" (no matching skill) is left untouched. Skipped
  // in Deep Research mode, which doesn't run the skill-capable agent.
  const invokedSkill = deepResearch ? null : await resolveSlashSkill(userId, message);
  const skillsContext = invokedSkill
    ? [
        baseSkillsContext,
        `The user explicitly invoked the "${invokedSkill}" skill with a slash command (/${invokedSkill}). ` +
          `Call the \`skill\` tool with name "${invokedSkill}" to load its full instructions, then follow ` +
          `them for this request. Treat the rest of the message (after the command) as the input to the skill.`,
      ]
        .filter(Boolean)
        .join("\n\n")
    : baseSkillsContext;

  // ---- Resolve the branch parent + load its history path ----
  // Every message lives in a TREE (Message.parentId). This turn extends ONE
  // branch: `branchParentId` is the message the new turn attaches under — the
  // current active leaf for a normal send, the edited user message's parent for
  // an edit, or the user message being re-answered for a regenerate. The model's
  // context is the chain of parents from `branchParentId` up to a root, NOT every
  // message in the conversation (that would leak sibling branches).
  const allMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
  });
  const messageById = new Map(allMessages.map((m) => [m.id, m]));

  // Where to attach this turn. The default (for an omitted parentId) is the
  // stored active leaf, then the most recent message (legacy chats), then null
  // (first turn / empty conversation).
  const defaultParentId: string | null =
    (conversationActiveLeafId && messageById.has(conversationActiveLeafId)
      ? conversationActiveLeafId
      : allMessages[allMessages.length - 1]?.id) ?? null;
  let branchParentId: string | null;
  if (requestedParentId === null) {
    // Explicit root (e.g. editing the very first user message).
    branchParentId = null;
  } else if (typeof requestedParentId === "string") {
    // A valid in-conversation id extends that branch. An unknown/stale id — e.g.
    // an unreconciled temp id left behind by a Stopped/failed turn — falls back
    // to the active leaf rather than silently starting a DETACHED root that would
    // drop all prior history from the model context and the visible path.
    branchParentId = messageById.has(requestedParentId)
      ? requestedParentId
      : defaultParentId;
  } else {
    // Omitted → continue the active branch.
    branchParentId = defaultParentId;
  }

  // Walk parent pointers from branchParentId up to a root (guard against cycles).
  const pathRecords: typeof allMessages = [];
  {
    const seen = new Set<string>();
    let cursor: string | null = branchParentId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const rec = messageById.get(cursor);
      if (!rec) break;
      pathRecords.unshift(rec);
      cursor = rec.parentId;
    }
  }

  const pathHistory: ChatMessage[] = pathRecords.map((m) => ({
    id: m.id,
    role: m.role as ChatRole,
    parentId: m.parentId ?? null,
    content: m.content,
    attachments: decodeJsonArray<Attachment>(m.attachments),
    toolCalls: decodeJsonArray<ToolCallRecord>(m.toolCalls),
    research: decodeResearch(m.research),
    subagents: decodeSubagents(m.subagents),
    createdAt: m.createdAt.toISOString(),
  }));

  // ---- Establish the user turn (existing on regenerate, fresh otherwise) ----
  // For a regenerate the "new" user turn is the existing message at the branch
  // tip; `history` is everything before it. Otherwise we persist a fresh user
  // message as a child of branchParentId and its whole path is the history.
  let history: ChatMessage[];
  let userMessage: ChatMessage;
  // Real id of the user message created THIS request (null on regenerate), sent
  // to the client via a `user_message` event so it can reconcile the optimistic
  // bubble. The assistant message hangs off this id.
  let createdUserMessageId: string | null = null;

  if (isRegenerate) {
    const parentRec = branchParentId ? messageById.get(branchParentId) : undefined;
    if (!parentRec || parentRec.role !== "user") {
      return Response.json(
        {
          error: "regenerate requires parentId to name a user message",
        } satisfies ApiError,
        { status: 400 },
      );
    }
    userMessage = pathHistory[pathHistory.length - 1];
    history = pathHistory.slice(0, -1);
    message = parentRec.content;
  } else {
    const userRecord = await prisma.message.create({
      data: {
        conversationId,
        parentId: branchParentId,
        role: "user",
        content: message,
        attachments: encodeJsonArray(attachments),
        toolCalls: null,
      },
    });
    createdUserMessageId = userRecord.id;
    userMessage = {
      id: userRecord.id,
      role: "user",
      parentId: branchParentId,
      content: message,
      attachments: attachments.length ? attachments : undefined,
      createdAt: userRecord.createdAt.toISOString(),
    };
    history = pathHistory;
  }

  // ---- Deep Research phase detection ----
  // Look at the most recent assistant turn on this branch: if it asked
  // clarifying questions, this turn (the user's answers) runs the full research
  // pipeline; otherwise a fresh Deep Research turn asks the questions first.
  const lastAssistant = [...history]
    .reverse()
    .find((m) => m.role === "assistant");
  // Auto-continue: if the previous assistant turn asked Deep Research clarifying
  // questions, a PLAIN answer this turn runs the report — no need to re-issue the
  // command. But only for a plain answer: a follow-up that is itself a slash
  // command (a fresh `/deep-research`, or any `/skill`) must NOT be swallowed
  // into the research pipeline — it takes precedence (resolveSlashSkill above
  // already resolved a skill for it). A regenerate never auto-continues research.
  if (
    !isRegenerate &&
    !rawMessage.startsWith("/") &&
    lastAssistant?.research?.phase === "clarifying"
  ) {
    deepResearch = true;
  }
  // A FRESH `/deep-research` command always starts a new research (clarify) turn
  // rather than being folded into a prior clarifying turn's report.
  const isResearchPhase =
    deepResearch &&
    !isDeepResearchCommand &&
    lastAssistant?.research?.phase === "clarifying";

  // Determine if we should auto-title: only on the first exchange of a convo
  // that still carries the default title.
  const shouldTitle =
    (isNewConversation || conversationTitle === "New chat") &&
    history.length === 0;

  // Pre-create the assistant message row so we can stream its id immediately and
  // update it on completion. It hangs off the user turn (regenerate: a sibling
  // reply under the same user message; otherwise the freshly-created user turn).
  const assistantRecord = await prisma.message.create({
    data: {
      conversationId,
      parentId: userMessage.id,
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
      const siteRefs: SiteRef[] = [];
      let toolSeq = 0;
      let sawError = false;
      // True once an artifact command was ATTEMPTED (even if it failed), so the
      // empty-reply retry doesn't misread a failed artifact turn as "nothing
      // happened" and re-run (which would just re-attempt the failing artifact).
      let artifactAttempted = false;
      // Same guard for site tool calls (a turn that only built/deployed a Site).
      let siteAttempted = false;
      // The user's auto-deploy opt-in, fetched lazily on the first deploy_site
      // call (avoids a query on turns that never touch sites).
      let sitesAutoDeploy: boolean | null = null;
      // Live parallel-subagent activity, upserted by id as the run_subagents tool
      // streams `subagent_activity` via the streamChat onEvent side channel;
      // persisted as the `subagents` column so the panel rehydrates on reload.
      const subagentActivities: SubagentActivity[] = [];
      // True once run_subagents was ATTEMPTED, so the empty-reply retry doesn't
      // re-dispatch subagents (mirrors artifactAttempted/siteAttempted).
      let subagentAttempted = false;
      // Live browser-control activity, upserted by id as the browser tools stream
      // `browser_activity` via the streamChat onEvent side channel; persisted as
      // the `browser` column so the panel rehydrates on reload.
      const browserActivities: BrowserActivity[] = [];
      // True once a browser tool was ATTEMPTED (mirrors subagentAttempted) so the
      // empty-reply retry doesn't re-drive the browser.
      let browserAttempted = false;
      // JSON-encoded ResearchState for Deep Research turns; null for normal chat.
      let researchColumn: string | null = null;

      // "Rewind code state": snapshot the workspace at the end of this turn (only
      // for turns that touched files, or once a snapshot store already exists so
      // the restore timeline stays 1:1 with turns). Best-effort — a snapshot
      // failure must never break the SSE stream.
      const snapshotWorkspaceTurn = async () => {
        try {
          const touchedFiles = toolCalls.some(
            (t) =>
              t.name === "write_file" ||
              t.name === "edit_file" ||
              t.name === "run_shell",
          );
          if (touchedFiles || (await hasSnapshotStore(conversationId))) {
            const sha = await snapshotTurn(conversationId, assistantMessageId);
            if (sha) await setSnapshotSha(assistantMessageId, sha);
          }
        } catch {
          // best-effort snapshot
        }
      };

      // Captured before streaming so reasoning duration is measured from the
      // moment we start the run. Date.now() is allowed in app code.
      const startedAt = Date.now();

      const send = (event: StreamEvent) => {
        try {
          controller.enqueue(sse(event));
        } catch {
          // The client disconnected (tab closed / Stop / navigation): enqueueing
          // on a cancelled controller throws. Degrade to a no-op so a still-live
          // background emitter — notably a run_subagents worker pushing progress
          // via onEvent — can never throw out of its tool's execute.
        }
      };

      // The run_subagents tool pushes `subagent_activity` events from inside its
      // execute via the streamChat `onEvent` side channel. Upsert by stable id
      // and forward to the client, mirroring the research_activity handling — and
      // ignore any other event kind defensively.
      const handleSubagentEvent = (event: StreamEvent) => {
        if (event.type !== "subagent_activity") return;
        subagentAttempted = true;
        const idx = subagentActivities.findIndex(
          (a) => a.id === event.activity.id,
        );
        if (idx >= 0) subagentActivities[idx] = event.activity;
        else subagentActivities.push(event.activity);
        send(event);
      };

      // The browser tools push `browser_activity` events from inside their execute
      // via the same onEvent side channel. Upsert by stable id and forward to the
      // client so the "Browser" panel renders live (mirrors handleSubagentEvent).
      const handleBrowserEvent = (event: StreamEvent) => {
        if (event.type !== "browser_activity") return;
        browserAttempted = true;
        const idx = browserActivities.findIndex(
          (a) => a.id === event.activity.id,
        );
        if (idx >= 0) browserActivities[idx] = event.activity;
        else browserActivities.push(event.activity);
        send(event);
      };

      try {
        // 1) message_id near the start. On a fresh (non-regenerate) turn also
        // announce the persisted user message's id + parent so the client can
        // reconcile its optimistic user bubble into the message tree.
        send({ type: "message_id", id: assistantMessageId });
        if (createdUserMessageId) {
          send({
            type: "user_message",
            id: createdUserMessageId,
            parentId: branchParentId,
          });
        }

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
          // The finished report, delivered by the pipeline's `research_report`
          // event. It becomes a `markdown` artifact (a side-panel document)
          // rather than inline chat text; the bubble gets a short lead-in below.
          let reportTitle = "";
          let reportContent = "";
          let reportArtifactCreated = false;

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
              case "research_report": {
                // Persist the report as a markdown artifact and open it in the
                // side panel (via the `artifact` event) instead of streaming it
                // into the chat bubble. The identifier is keyed to this message
                // so a regenerate produces a distinct artifact rather than
                // versioning an unrelated prior report.
                reportTitle = event.title || researchPlan?.title || "Research Report";
                reportContent = event.content;
                // Skip on an errored run: don't publish a success artifact for a
                // truncated report, and honor the "no events after error"
                // ordering (an `error` was already sent). The partial report
                // still falls back to inline content below, so it isn't lost.
                if (reportContent.trim() && !sawError) {
                  artifactAttempted = true;
                  try {
                    const result = await applyArtifactCommand(prisma, {
                      conversationId,
                      messageId: assistantMessageId,
                      command: "create",
                      args: {
                        identifier: `research-report-${assistantMessageId}`,
                        title: reportTitle,
                        content: reportContent,
                        type: "markdown",
                      },
                    });
                    if (result.ok) {
                      artifactRefs.push(result.ref);
                      reportArtifactCreated = true;
                      send({
                        type: "artifact",
                        command: "create",
                        artifact: result.snapshot,
                      });
                    } else {
                      console.error(
                        "[chat] research report artifact failed:",
                        result.error,
                      );
                    }
                  } catch (err) {
                    console.error(
                      "[chat] research report artifact error:",
                      err,
                    );
                  }
                }
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

          // The report lives in the artifact panel, so the chat bubble carries
          // only a short lead-in pointing at it. If the artifact could not be
          // created (empty report or a persistence error), fall back to showing
          // the report inline so the research is never lost.
          if (reportArtifactCreated) {
            assembled = buildReportLeadIn(reportTitle, sourceCount);
          } else if (reportContent.trim()) {
            assembled = reportContent;
          } else if (!sawError && assembled.trim() === "") {
            // No report and no error surfaced: never leave a blank bubble.
            assembled =
              "I wasn't able to produce a research report this time. Please try again.";
          }

          // The report body was delivered via the `artifact` event; synthesis
          // `delta`s were buffered, not streamed, so nothing has populated the
          // live message content yet. Emit the bubble text as a single delta so
          // it shows during the turn (not only after a reload). Suppressed on
          // error to honor "error then close — no events after error"; the
          // content still persists below and reappears on reload.
          if (assembled && !sawError) {
            send({ type: "delta", text: assembled });
          }

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
          skillsContext,
          // Fan the tool side-channel to both rich-panel handlers; each ignores
          // event kinds it doesn't own, so composing them is safe.
          onEvent: (event) => {
            handleSubagentEvent(event);
            handleBrowserEvent(event);
          },
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
              // Site tool calls are intercepted the same way: persist via
              // applySiteCommand and emit a dedicated `site` event that drives
              // the in-chat Site panel, instead of a generic tool card.
              const siteCommand = toolNameToSiteCommand(event.name);
              if (siteCommand) {
                siteAttempted = true;
                try {
                  let canDeploy = false;
                  if (siteCommand === "deploy") {
                    if (sitesAutoDeploy === null) {
                      const u = await prisma.user.findUnique({
                        where: { id: userId },
                        select: { sitesAutoDeploy: true },
                      });
                      sitesAutoDeploy = u?.sitesAutoDeploy ?? false;
                    }
                    canDeploy = sitesAutoDeploy;
                  }
                  const result = await applySiteCommand(prisma, {
                    userId,
                    conversationId,
                    messageId: assistantMessageId,
                    command: siteCommand,
                    args: event.args,
                    canDeploy,
                  });
                  if (result.ok) {
                    siteRefs.push(result.ref);
                    send({ type: "site", command: siteCommand, site: result.snapshot });
                  } else {
                    console.error("[chat] site command failed:", result.error);
                  }
                } catch (err) {
                  console.error("[chat] site persistence error:", err);
                }
                break;
              }
              // run_subagents is intercepted too: its live progress renders as
              // the dedicated "Subagents" panel (driven by `subagent_activity`
              // events already forwarded via onEvent), so suppress the generic
              // tool card here. The model still receives the tool's digest result.
              if (isSubagentToolName(event.name)) {
                subagentAttempted = true;
                break;
              }
              // Browser tools are intercepted the same way: their live progress
              // renders as the "Browser" panel (driven by `browser_activity`
              // events already forwarded via onEvent), so suppress the generic
              // tool card. The model still receives the tool's own function result.
              if (isBrowserToolName(event.name)) {
                browserAttempted = true;
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
              // Artifact + site + subagent tools have no visible "tool" card, so
              // skip their results (handled in the tool_call branch above / via
              // the subagent panel).
              if (
                isArtifactToolName(event.name) ||
                isSiteToolName(event.name) ||
                isSubagentToolName(event.name) ||
                isBrowserToolName(event.name)
              )
                break;
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
          !artifactAttempted &&
          siteRefs.length === 0 &&
          !siteAttempted &&
          !subagentAttempted &&
          !browserAttempted
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
        finalizeSubagents(subagentActivities);
        finalizeBrowser(browserActivities);
        await prisma.message.update({
          where: { id: assistantMessageId },
          data: {
            content: assembled,
            toolCalls: encodeJsonArray(toolCalls),
            timeline: encodeJsonArray(timeline),
            reasoning: reasoning.length > 0 ? reasoning : null,
            reasoningMs,
            artifactRefs: encodeJsonArray(artifactRefs),
            siteRefs: encodeJsonArray(siteRefs),
            research: researchColumn,
            subagents: encodeSubagents(subagentActivities),
            browser: encodeBrowser(browserActivities),
          },
        });

        // Point the conversation's active leaf at this reply so the freshly
        // extended branch is what rehydrates on reload.
        const convoData: {
          updatedAt: Date;
          title?: string;
          activeLeafId: string;
        } = {
          updatedAt: new Date(),
          activeLeafId: assistantMessageId,
        };
        if (newTitle) convoData.title = newTitle;
        await prisma.conversation.update({
          where: { id: conversationId },
          data: convoData,
        });

        // Capture a "rewind code state" checkpoint of the workspace at this turn.
        // Best-effort — must never break the SSE stream.
        await snapshotWorkspaceTurn();

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
          finalizeSubagents(subagentActivities);
          finalizeBrowser(browserActivities);
          await prisma.message.update({
            where: { id: assistantMessageId },
            data: {
              content: assembled,
              toolCalls: encodeJsonArray(toolCalls),
              timeline: encodeJsonArray(timeline),
              reasoning: reasoning.length > 0 ? reasoning : null,
              reasoningMs,
              artifactRefs: encodeJsonArray(artifactRefs),
              siteRefs: encodeJsonArray(siteRefs),
              research: researchColumn,
              subagents: encodeSubagents(subagentActivities),
              browser: encodeBrowser(browserActivities),
            },
          });
          await prisma.conversation.update({
            where: { id: conversationId },
            data: { updatedAt: new Date(), activeLeafId: assistantMessageId },
          });
          await snapshotWorkspaceTurn();
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
