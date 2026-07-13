import type { MCPServer } from "@openai/agents-core";
import type { McpToolInfo } from "@/lib/types";

/**
 * The SDK only re-exports the `MCPServer` *interface* from the package root —
 * `MCPTool` and `CallToolResultContent` are not re-exported. We recover them
 * structurally from `MCPServer`'s own method signatures so we stay decoupled
 * from internal subpaths while remaining type-exact.
 */
type MCPTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];
type CallToolResultContent = Awaited<ReturnType<MCPServer["callTool"]>>;

/**
 * A remote MCP server speaking JSON-RPC 2.0 over Streamable HTTP. Implements the
 * SDK's {@link MCPServer} interface so it can be passed directly to an Agent via
 * the `mcpServers` option. The caller is responsible for awaiting {@link connect}
 * before a run and calling {@link close} afterwards (in a finally).
 *
 * Wire details: every request is a POST to the MCP url with
 *   Accept: application/json, text/event-stream
 *   Content-Type: application/json
 * The server may answer with either application/json or a text/event-stream
 * (SSE) body; {@link rpc} normalizes both. The Mcp-Session-Id response header
 * from `initialize` is captured and echoed on every subsequent request.
 */
const REQUEST_TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "openagent", version: "1.0.0" };

/** JSON-RPC error thrown by {@link RemoteMCPServer.rpc}. */
class JsonRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

/** Raised internally when an HTTP request returns 401. */
class UnauthorizedError extends Error {
  constructor(readonly wwwAuthenticate: string | null) {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function coerceInputSchema(
  schema: unknown,
): MCPTool["inputSchema"] {
  const s = schema as Partial<MCPTool["inputSchema"]> | undefined;
  return {
    type: "object",
    properties:
      s && typeof s.properties === "object" && s.properties !== null
        ? (s.properties as Record<string, unknown>)
        : {},
    required: s && Array.isArray(s.required) ? s.required : [],
    additionalProperties:
      s && typeof s.additionalProperties === "boolean"
        ? s.additionalProperties
        : false,
  };
}

export class RemoteMCPServer implements MCPServer {
  cacheToolsList = true;

  private readonly url: string;
  private readonly _name: string;
  private readonly getAccessToken?: () => Promise<string | null>;

  private sessionId: string | null = null;
  private cachedTools: MCPTool[] | null = null;
  private nextId = 1;

  constructor(opts: {
    url: string;
    name: string;
    getAccessToken?: () => Promise<string | null>;
  }) {
    this.url = opts.url;
    this._name = opts.name;
    this.getAccessToken = opts.getAccessToken;
  }

  get name(): string {
    return this._name;
  }

  /** Perform the MCP initialize handshake and capture the session id. */
  async connect(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    // Fire-and-forget the initialized notification (no response expected).
    await this.notify("notifications/initialized");
  }

  /** Best-effort HTTP DELETE of the session. Errors are swallowed. */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        "Mcp-Session-Id": this.sessionId,
      };
      const token = this.getAccessToken
        ? await this.getAccessToken()
        : null;
      if (token) headers["Authorization"] = `Bearer ${token}`;
      await fetch(this.url, {
        method: "DELETE",
        headers,
        signal: controller.signal,
      });
    } catch {
      // Ignore — closing a session is advisory.
    } finally {
      clearTimeout(timer);
      this.sessionId = null;
    }
  }

  async listTools(): Promise<MCPTool[]> {
    if (this.cacheToolsList && this.cachedTools) return this.cachedTools;
    const result = (await this.rpc("tools/list")) as {
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema?: unknown;
      }>;
    };
    const tools: MCPTool[] = (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: coerceInputSchema(t.inputSchema),
    }));
    this.cachedTools = tools;
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent> {
    const result = (await this.rpc("tools/call", {
      name,
      arguments: args ?? {},
    })) as { content?: CallToolResultContent };
    return result.content ?? [];
  }

  // ---- internals ---------------------------------------------------------

  /**
   * Send a JSON-RPC request and return its `result`. Handles both
   * application/json and text/event-stream responses. On a 401, if a token
   * provider exists, fetches a (possibly refreshed) token once and retries;
   * a persistent 401 throws an Error mentioning authorization.
   */
  private async rpc(method: string, params?: unknown): Promise<unknown> {
    try {
      return await this.doRpc(method, params);
    } catch (err) {
      if (err instanceof UnauthorizedError && this.getAccessToken) {
        const token = await this.getAccessToken();
        if (token) {
          try {
            return await this.doRpc(method, params, token);
          } catch (retryErr) {
            if (retryErr instanceof UnauthorizedError) {
              throw new Error(
                `MCP request "${method}" failed: authorization required (401).`,
              );
            }
            throw retryErr;
          }
        }
        throw new Error(
          `MCP request "${method}" failed: authorization required (401).`,
        );
      }
      if (err instanceof UnauthorizedError) {
        throw new Error(
          `MCP request "${method}" failed: authorization required (401).`,
        );
      }
      throw err;
    }
  }

  private async buildHeaders(
    overrideToken?: string,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const token =
      overrideToken ??
      (this.getAccessToken ? await this.getAccessToken() : null);
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return headers;
  }

  /** Send a notification (no `id`, no response parsed). */
  private async notify(method: string, params?: unknown): Promise<void> {
    const headers = await this.buildHeaders();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
        signal: controller.signal,
      });
    } catch {
      // Notifications are best-effort.
    } finally {
      clearTimeout(timer);
    }
  }

  private async doRpc(
    method: string,
    params: unknown,
    overrideToken?: string,
  ): Promise<unknown> {
    const id = this.nextId++;
    const headers = await this.buildHeaders(overrideToken);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) {
      throw new UnauthorizedError(res.headers.get("www-authenticate"));
    }

    // Capture the session id from the initialize response.
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (!res.ok) {
      throw new JsonRpcError(
        `MCP request "${method}" failed with HTTP ${res.status}.`,
      );
    }

    const contentType = res.headers.get("content-type") ?? "";
    let message: JsonRpcResponse;
    if (contentType.includes("text/event-stream")) {
      message = await this.readSseResponse(res, id);
    } else {
      message = (await res.json()) as JsonRpcResponse;
    }

    if (message.error) {
      throw new JsonRpcError(message.error.message, message.error.code);
    }
    return message.result;
  }

  /**
   * Read a text/event-stream body, parse `data:` lines as JSON and return the
   * message whose `id` matches the request. Mirrors the SSE parsing in
   * src/lib/sse.ts but is self-contained (no server-only imports).
   */
  private async readSseResponse(
    res: Response,
    requestId: number,
  ): Promise<JsonRpcResponse> {
    if (!res.body) {
      throw new JsonRpcError("MCP SSE response had no body.");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Scan one SSE event block ("data:" lines) for a JSON-RPC message matching
    // the request id. Returns the message, or null if no match in this block.
    const matchInBlock = (raw: string): JsonRpcResponse | null => {
      for (const lineRaw of raw.split("\n")) {
        const line = lineRaw.trim();
        if (!line.startsWith("data:")) continue;
        const json = line.slice(line.indexOf(":") + 1).trim();
        if (!json) continue;
        try {
          const parsed = JSON.parse(json) as JsonRpcResponse;
          if (parsed.id === requestId) return parsed;
        } catch {
          // Ignore non-JSON data lines.
        }
      }
      return null;
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          // Flush a final event that wasn't terminated by a blank line — some
          // servers close the stream right after the response without "\n\n".
          buffer += decoder.decode();
          const tail = matchInBlock(buffer);
          if (tail) return tail;
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const match = matchInBlock(raw);
          if (match) return match;
        }
      }
    } finally {
      reader.releaseLock();
    }
    throw new JsonRpcError(
      "MCP SSE stream ended before a matching response arrived.",
    );
  }
}

/** Result of {@link probeMcpServer} — a discriminated union on `status`. */
export type ProbeResult =
  | { status: "connected"; tools: McpToolInfo[] }
  | { status: "unauthorized"; wwwAuthenticate: string | null }
  | { status: "error"; error: string };

/**
 * Connect to a remote MCP server and list its tools without persisting
 * anything. A 401 maps to "unauthorized" (with the WWW-Authenticate header when
 * available), other failures to "error", and success to "connected".
 */
export async function probeMcpServer(
  url: string,
  accessToken?: string | null,
): Promise<ProbeResult> {
  const server = new RemoteMCPServer({
    url,
    name: url,
    getAccessToken: accessToken
      ? async () => accessToken
      : undefined,
  });
  try {
    await server.connect();
    const tools = await server.listTools();
    return {
      status: "connected",
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
      })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/authorization required \(401\)/i.test(message)) {
      // Re-issue a raw initialize to recover the WWW-Authenticate header, which
      // the normalized Error above discards.
      const wwwAuthenticate = await probeWwwAuthenticate(url, accessToken);
      return { status: "unauthorized", wwwAuthenticate };
    }
    return { status: "error", error: message };
  } finally {
    await server.close();
  }
}

/**
 * Raw initialize POST used purely to capture the WWW-Authenticate header on a
 * 401. Returns null on any other outcome.
 */
async function probeWwwAuthenticate(
  url: string,
  accessToken?: string | null,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      }),
      signal: controller.signal,
    });
    if (res.status === 401) {
      return res.headers.get("www-authenticate");
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
