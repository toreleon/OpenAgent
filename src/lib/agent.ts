import {
  Agent,
  run,
  user,
  assistant,
  system,
  setDefaultOpenAIKey,
  setDefaultOpenAIClient,
  setTracingDisabled,
  type AgentInputItem,
  type RunStreamEvent,
} from "@openai/agents";
import OpenAI from "openai";
import type {
  ChatMessage,
  StreamEvent,
  Attachment,
  ReasoningEffort,
  ToolCallRecord,
} from "@/lib/types";
import { DEFAULT_EFFORT } from "@/lib/types";
import { agentTools } from "@/lib/tools";
import { loadUserMcpServers } from "@/lib/mcp";
import type { MCPServer } from "@openai/agents-core";

/**
 * Parameters accepted by {@link streamChat}. See CONTRACTS.md §2.
 */
export interface StreamChatParams {
  /** The chosen model id (one of MODELS[].id). */
  model: string;
  /** Full prior conversation history (oldest first), excluding the new turn. */
  history: ChatMessage[];
  /** The new user message (already persisted by the caller). */
  userMessage: ChatMessage;
  /**
   * Reasoning effort for this turn. Flows into the Agent's
   * `modelSettings.providerData.reasoning.effort`. Falls back to
   * {@link DEFAULT_EFFORT} when undefined. See CONTRACTS.md §9.
   */
  effort?: ReasoningEffort;
  /**
   * The id of the authenticated user whose chat this is. Used to load that
   * user's enabled+trusted+connected MCP connectors and expose their tools to
   * the agent for this turn.
   */
  userId: string;
}

const INSTRUCTIONS = `You are a helpful, knowledgeable, and friendly AI assistant, similar to ChatGPT.

Guidelines:
- Be concise by default, but thorough when the question warrants it.
- Format responses in clean Markdown. Use fenced code blocks with language tags for code, tables where helpful, and lists for steps.
- For mathematics, use LaTeX: wrap inline math in \\( ... \\) or $ ... $, and display equations in \\[ ... \\] or $$ ... $$. The UI renders these with KaTeX.
- When you are unsure or information may be out of date, use the web search tool to find current information, and cite what you found.
- Use the run_javascript tool for arithmetic, data transformation, or quick computations rather than doing error-prone math in your head.
- Use the get_current_time tool when the user asks about the current date or time, or when you need to compute relative dates.
- If the user shares an image, look at it carefully and describe or reason about its contents as needed.
- Never claim to have taken real-world actions you cannot perform. Be honest about your limitations.

Artifacts:
- You can create "artifacts" — substantial, self-contained pieces of content shown to the user in a dedicated side panel — using the create_artifact, update_artifact, and rewrite_artifact tools.
- CREATE an artifact for content the user will likely keep, edit, run, or preview: code files or components longer than ~15 lines, complete programs, full documents/essays, HTML pages, SVG or image assets, Mermaid diagrams, or interactive React components.
- Do NOT use artifacts for short snippets, one-off examples, or content that only makes sense inline in the conversation. When in doubt for something small, just use a normal fenced code block in your reply.
- Choose the right \`type\`: 'code' (set \`language\`), 'markdown', 'html' (a complete self-contained page), 'svg', 'image' (an image/data URL), 'mermaid', or 'react'.
- For 'react': write a single self-contained component and make it the DEFAULT export (e.g. \`export default function App() { ... }\`). Import React hooks and any libraries you use (react, recharts, lucide-react, framer-motion, d3, three are available). Use Tailwind classes for styling. Do not read from files, the network, or environment variables.
- For 'html': output a complete document; you may use <script> and <style> and load libraries from a CDN.
- Keep ONE artifact per distinct deliverable, and give it a short kebab-case \`identifier\`. To revise an existing artifact, call update_artifact (small exact-substring edits) or rewrite_artifact (larger changes) with the SAME identifier — do not create a new one.
- After creating or updating an artifact, briefly describe it in your reply; do NOT paste the artifact's full content back into the message.`;

let clientConfigured = false;

/**
 * Configure the OpenAI client for the Agents SDK. Supports both the public
 * OpenAI API and OpenAI-compatible endpoints (e.g. Azure AI Services'
 * `/openai/v1/` surface) via OPENAI_BASE_URL. Returns false if no key is set so
 * callers can surface a graceful error instead of throwing during build/request.
 */
function ensureApiKey(): boolean {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return false;
  if (clientConfigured) return true;

  try {
    const baseURL = process.env.OPENAI_BASE_URL;
    if (baseURL) {
      // Custom/Azure-compatible endpoint: build an OpenAI client pointed at it.
      // We send both the bearer key (default) and an `api-key` header so the
      // same config works against either OpenAI or Azure auth schemes.
      const client = new OpenAI({
        apiKey: key,
        baseURL,
        defaultHeaders: { "api-key": key },
      });
      setDefaultOpenAIClient(client);
    } else {
      setDefaultOpenAIKey(key);
    }
    // Tracing exports to the OpenAI platform and would fail (or leak) against a
    // non-OpenAI endpoint, so disable it unless explicitly opted in.
    if (process.env.OPENAI_AGENTS_TRACING !== "1") {
      setTracingDisabled(true);
    }
    clientConfigured = true;
  } catch {
    // Setters are effectively idempotent; ignore double-configure races.
    clientConfigured = true;
  }
  return true;
}

/** Resolve the model actually sent to the provider. A configured OPENAI_MODEL
 * (e.g. an Azure deployment name) overrides the UI selection so requests always
 * target a model that exists on the configured endpoint. */
function resolveModel(requested: string): string {
  return process.env.OPENAI_MODEL || requested;
}

/**
 * Convert one of our persisted ChatMessages into the user-content array the
 * Agents SDK expects, attaching any image/file inputs for vision-capable
 * models.
 */
function buildUserContent(
  text: string,
  attachments: Attachment[] | undefined,
): Parameters<typeof user>[0] {
  const images = (attachments ?? []).filter((a) => a.kind === "image");
  const files = (attachments ?? []).filter((a) => a.kind !== "image");

  if (images.length === 0 && files.length === 0) {
    return text;
  }

  const content: Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; image: string }
    | { type: "input_file"; file: string }
  > = [];

  if (text.trim()) {
    content.push({ type: "input_text", text });
  }

  for (const img of images) {
    content.push({ type: "input_image", image: toAbsoluteUrl(img.url) });
  }
  for (const file of files) {
    // Non-image files are surfaced as input_file when a public URL exists.
    content.push({ type: "input_file", file: toAbsoluteUrl(file.url) });
  }

  // The SDK's `user()` helper accepts UserContent[]; our literal matches that
  // discriminated union shape.
  return content as unknown as Parameters<typeof user>[0];
}

/**
 * Attachment URLs are stored as site-relative paths (e.g. "/uploads/x.png").
 * The OpenAI Responses API needs a fetchable absolute URL. Use the configured
 * public base URL when available; otherwise pass the value through (data: URLs
 * and already-absolute URLs are returned unchanged).
 */
function toAbsoluteUrl(url: string): string {
  if (/^(https?:|data:)/i.test(url)) return url;
  const base =
    process.env.NEXTAUTH_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.APP_URL ||
    "";
  if (!base) return url;
  return `${base.replace(/\/+$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
}

/**
 * Map our stored history + new user message into the Agents SDK input items.
 */
function buildInput(
  history: ChatMessage[],
  userMessage: ChatMessage,
): AgentInputItem[] {
  const items: AgentInputItem[] = [];

  for (const msg of history) {
    if (!msg.content && !(msg.attachments && msg.attachments.length)) continue;
    switch (msg.role) {
      case "user":
        items.push(user(buildUserContent(msg.content, msg.attachments)));
        break;
      case "assistant":
        items.push(assistant(msg.content));
        break;
      case "system":
        items.push(system(msg.content));
        break;
      // "tool" role history is not replayed as input; tool results are
      // reconstructed by the model from the surrounding assistant text.
      default:
        break;
    }
  }

  items.push(
    user(buildUserContent(userMessage.content, userMessage.attachments)),
  );

  return items;
}

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

/**
 * Run the agent with streaming and yield our StreamEvent union. Does NOT emit
 * `message_id`, `title`, or `done` — the /api/chat route owns those framing
 * events. May yield an `error` event on internal failure.
 */
export async function* streamChat(
  params: StreamChatParams,
): AsyncIterable<StreamEvent> {
  const { model, history, userMessage } = params;
  const effort: ReasoningEffort = params.effort ?? DEFAULT_EFFORT;

  if (!ensureApiKey()) {
    yield {
      type: "error",
      message:
        "The server is missing OPENAI_API_KEY. Set it in your environment to enable chat.",
    };
    return;
  }

  // Load this user's enabled+trusted+connected MCP connectors. A failure here
  // (e.g. DB error) must never break the chat — fall back to no MCP servers.
  let mcpServers: MCPServer[] = [];
  try {
    mcpServers = await loadUserMcpServers(params.userId);
  } catch (err) {
    console.error("[agent] failed to load MCP servers:", err);
    mcpServers = [];
  }

  // The SDK computes tools at run time but expects each server to already be
  // connected. Connect up front and skip any server that fails, mirroring the
  // SDK's "skip servers that fail" behavior. Only successfully-connected
  // servers are handed to the Agent (and later closed).
  const connectedServers: MCPServer[] = [];
  for (const server of mcpServers) {
    try {
      await server.connect();
      connectedServers.push(server);
    } catch (err) {
      console.error(
        `[agent] skipping MCP server "${server.name}" (connect failed):`,
        err,
      );
    }
  }

  // Close all connected servers exactly once, after the run settles or errors.
  // Closing must never throw.
  const closeServers = async () => {
    await Promise.all(
      connectedServers.map(async (server) => {
        try {
          await server.close();
        } catch (err) {
          console.error(
            `[agent] error closing MCP server "${server.name}":`,
            err,
          );
        }
      }),
    );
  };

  let agent: Agent;
  try {
    agent = new Agent({
      name: "Assistant",
      instructions: INSTRUCTIONS,
      model: resolveModel(model),
      tools: agentTools,
      mcpServers: connectedServers,
      modelSettings: {
        // @openai/agents-core ModelSettings has NO top-level `reasoning` field;
        // providerData is spread verbatim into the Responses request body
        // (openaiResponsesModel.mjs ~line 520: `...request.modelSettings.providerData`).
        // This makes the model emit a reasoning summary we can stream. See §9.
        providerData: { reasoning: { effort, summary: "auto" } },
      },
    });
  } catch (err) {
    await closeServers();
    yield {
      type: "error",
      message:
        err instanceof Error
          ? `Failed to initialize agent: ${err.message}`
          : "Failed to initialize agent.",
    };
    return;
  }

  const input = buildInput(history, userMessage);

  // Tracks whether we've already emitted the single `reasoning_done` event, so
  // it fires exactly once — right before the first answer `delta`. See §9.
  let reasoningDone = false;

  try {
    const streamed = await run(agent, input, { stream: true });

    for await (const event of streamed as AsyncIterable<RunStreamEvent>) {
      if (event.type === "raw_model_stream_event") {
        const data = event.data as {
          type?: string;
          delta?: unknown;
          event?: { type?: string; delta?: unknown };
        };

        // Final answer text. Emit a single `reasoning_done` just before the
        // first answer chunk if the reasoning summary never explicitly closed.
        if (data?.type === "output_text_delta" && typeof data.delta === "string") {
          if (data.delta.length > 0) {
            if (!reasoningDone) {
              reasoningDone = true;
              yield { type: "reasoning_done" };
            }
            yield { type: "delta", text: data.delta };
          }
          continue;
        }

        // Reasoning summary text is wrapped under the "model" raw event, whose
        // native Responses event lives at data.event.
        if (data?.type === "model" && data.event) {
          const ev = data.event;
          if (
            ev.type === "response.reasoning_summary_text.delta" &&
            typeof ev.delta === "string"
          ) {
            if (ev.delta.length > 0) {
              yield { type: "reasoning_delta", text: ev.delta };
            }
          } else if (
            ev.type === "response.reasoning_summary_text.done" &&
            !reasoningDone
          ) {
            reasoningDone = true;
            yield { type: "reasoning_done" };
          }
        }
        continue;
      }

      if (event.type === "run_item_stream_event") {
        const raw = (event.item as { rawItem?: unknown }).rawItem;

        if (event.name === "tool_called") {
          const name =
            readString(raw, "name") ?? readString(event.item, "name") ?? "tool";
          const args = parseArgs(readString(raw, "arguments"));
          yield { type: "tool_call", name, args: args ?? {} };
          continue;
        }

        if (event.name === "tool_output") {
          const name =
            readString(raw, "name") ?? readString(event.item, "name") ?? "tool";
          // Tool output may live under rawItem.output (string or object).
          let output: unknown = undefined;
          if (raw && typeof raw === "object" && "output" in raw) {
            output = (raw as Record<string, unknown>).output;
          }
          if (typeof output === "string") {
            output = parseArgs(output);
          }
          yield { type: "tool_result", name, output: output ?? null };
          continue;
        }
      }
    }

    // Ensure the run fully settled (surfaces late errors).
    await streamed.completed;
  } catch (err) {
    yield {
      type: "error",
      message:
        err instanceof Error
          ? err.message
          : "The assistant failed to generate a response.",
    };
  } finally {
    // Always release MCP connections after the run completes or errors.
    await closeServers();
  }
}

/**
 * The fully-assembled result of a non-streaming agent run. Used by the scheduler
 * (and any server-side caller) that needs the complete reply rather than an SSE
 * stream.
 */
export interface RunChatResult {
  /** The assembled assistant answer text. */
  content: string;
  /** Reasoning summary text, if the model produced one. */
  reasoning?: string;
  /** Time spent producing the reasoning summary, in ms. */
  reasoningMs?: number;
  /** Tool calls made during the run, with outputs attached where available. */
  toolCalls: ToolCallRecord[];
  /** Set to the error message if the run failed (content may be partial). */
  error?: string;
}

/**
 * Run the agent to completion by draining {@link streamChat} server-side and
 * assembling the full result. This is the non-streaming counterpart to the SSE
 * path in /api/chat and shares the exact same agent configuration and event
 * semantics (see CONTRACTS.md §9). It never throws: transport/model failures are
 * surfaced on {@link RunChatResult.error} alongside whatever was assembled.
 */
export async function runChatCompletion(
  params: StreamChatParams,
): Promise<RunChatResult> {
  let content = "";
  let reasoning = "";
  let reasoningMs: number | undefined;
  const toolCalls: ToolCallRecord[] = [];
  let toolSeq = 0;
  let error: string | undefined;

  const startedAt = Date.now();

  try {
    for await (const event of streamChat(params)) {
      switch (event.type) {
        case "reasoning_delta":
          reasoning += event.text;
          break;
        case "reasoning_done":
          if (reasoningMs === undefined) reasoningMs = Date.now() - startedAt;
          break;
        case "delta":
          content += event.text;
          break;
        case "tool_call":
          toolCalls.push({
            id: `tool_${toolSeq++}`,
            name: event.name,
            args: event.args,
          });
          break;
        case "tool_result":
          for (let i = toolCalls.length - 1; i >= 0; i--) {
            if (toolCalls[i].name === event.name && toolCalls[i].output === undefined) {
              toolCalls[i].output = event.output;
              break;
            }
          }
          break;
        case "error":
          error = event.message;
          break;
        default:
          break;
      }
    }
  } catch (err) {
    error =
      err instanceof Error
        ? err.message
        : "The assistant failed to generate a response.";
  }

  return {
    content,
    reasoning: reasoning.length > 0 ? reasoning : undefined,
    reasoningMs,
    toolCalls,
    error,
  };
}
