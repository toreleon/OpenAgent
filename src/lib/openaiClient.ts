import OpenAI from "openai";
import {
  setDefaultOpenAIKey,
  setDefaultOpenAIClient,
  setTracingDisabled,
} from "@openai/agents";

/**
 * Shared OpenAI/Agents-SDK client configuration.
 *
 * Extracted from src/lib/agent.ts so BOTH the main chat agent and the parallel
 * subagent runner (src/lib/subagents/runner.ts) can ensure the client is
 * configured without importing each other (which would create a module cycle:
 * agent → tools → run_subagents → runner → agent). This module has no app-code
 * imports, so it sits safely at the bottom of the graph.
 *
 * `clientConfigured` is a module-level singleton: the first caller configures
 * the default client/key for the whole process; later calls are no-ops.
 */

let clientConfigured = false;

/**
 * Configure the OpenAI client for the Agents SDK. Supports both the public
 * OpenAI API and OpenAI-compatible endpoints (e.g. Azure AI Services'
 * `/openai/v1/` surface) via OPENAI_BASE_URL. Returns false if no key is set so
 * callers can surface a graceful error instead of throwing during build/request.
 */
export function ensureApiKey(): boolean {
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
export function resolveModel(requested: string): string {
  return process.env.OPENAI_MODEL || requested;
}

/**
 * Guard a streamed run's `.completed` promise, then return it.
 *
 * The Agents SDK rejects `.completed` the instant the run fails (e.g.
 * MaxTurnsExceeded). That rejection can land WHILE the caller is still draining
 * the event iterator — before it reaches `await completed`. A rejected promise
 * with no handler already attached triggers Node's `unhandledRejection`, which
 * crashes the process. Attaching an eager no-op catch marks it "handled"; the
 * returned promise is the SAME one, so `await`-ing it still surfaces the real
 * error to the caller's try/catch as normal.
 */
export function guardCompletion<T>(streamed: { completed: Promise<T> }): Promise<T> {
  const { completed } = streamed;
  completed.catch(() => {});
  return completed;
}
