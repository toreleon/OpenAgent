import type { Tool } from "@openai/agents";
import { getCurrentTimeTool } from "./get-current-time";
import { runJavascriptTool } from "./run-javascript";
import { hostedWebSearchTool, webSearchFunctionTool } from "./web-search";
import { webFetchTool } from "./web-fetch";
import { artifactTools } from "./artifacts";
import { siteTools } from "./sites";
import { readFileTool } from "./read-file";
import { listDirTool } from "./list-dir";
import { grepSearchTool } from "./grep-search";
import { editFileTool } from "./edit-file";
import { writeFileTool } from "./write-file";
import { runShellTool } from "./run-shell";
import { skillTool } from "./skill";
import { runSubagentsTool } from "./run-subagents";
import { browserTools } from "./browser";

/**
 * The full set of tools available to the chat agent. Order is not significant;
 * the model chooses which (if any) to call.
 *
 * The hosted web-search tool serializes as the OpenAI `web_search_preview` tool
 * type, which is only supported by the public OpenAI Responses API. Azure /
 * OpenAI-compatible endpoints reject unknown tool types and would 400 the entire
 * request, so we only register it when no custom `OPENAI_BASE_URL` is set.
 *
 * The portable `web_search` function tool (webSearchFunctionTool) is always
 * registered — it runs against a pluggable, mostly keyless backend, so the agent
 * has real search everywhere. It returns lightweight title/url/snippet results;
 * the agent reads a page's contents with `web_fetch` (webFetchTool).
 *
 * The coding-sandbox tools (read_file, list_dir, grep_search, edit_file,
 * write_file, run_shell) operate on a confined per-conversation workspace at
 * `.workspaces/<conversationId>/repo`. They are portable function tools, so they
 * are registered unconditionally. The conversationId is threaded to them via the
 * Agents SDK RunContext (see src/lib/agent.ts), never from a model argument, so a
 * model can only touch its own conversation's workspace.
 */
export const agentTools: Tool[] = [
  ...(process.env.OPENAI_BASE_URL ? [] : [hostedWebSearchTool]),
  webSearchFunctionTool,
  webFetchTool,
  runJavascriptTool,
  getCurrentTimeTool,
  ...artifactTools,
  // Sites: build + publish a standalone, shareable web page (create/update/deploy).
  // Intercepted by /api/chat like the artifact tools; deploy is gated by the
  // user's sitesAutoDeploy opt-in. See src/lib/sites.ts.
  ...siteTools,
  // Coding sandbox (local, per-conversation workspace).
  readFileTool,
  listDirTool,
  grepSearchTool,
  editFileTool,
  writeFileTool,
  runShellTool,
  // Installed plugin skills (progressive disclosure). No-op when the user has no
  // enabled skills — it just reports "no such skill". Reads the calling user's
  // skills via the RunContext userId (see src/lib/agent.ts), never a model arg.
  skillTool,
  // Parallel subagents (Claude-Desktop-style orchestrator → workers). Dispatches
  // independent subtasks as concurrent, read-only research agents. Intercepted by
  // /api/chat (like the artifact/site tools) so its progress renders as the rich
  // "Subagents" panel instead of a generic tool card. See src/lib/subagents.
  runSubagentsTool,
  // Built-in browser control (per-conversation headless Chromium, accessibility-
  // tree grounding). Intercepted by /api/chat like the artifact/subagent tools so
  // its live progress renders as the "Browser" panel. Gated OFF by default — only
  // registered when BROWSER_CONTROL_ENABLED=1 — until the P2 security hardening
  // (connect-time SSRF proxy + action confirmation) lands. See src/lib/browser.
  ...(process.env.BROWSER_CONTROL_ENABLED === "1" ? browserTools : []),
];

export {
  getCurrentTimeTool,
  runJavascriptTool,
  hostedWebSearchTool,
  webSearchFunctionTool,
  webFetchTool,
  artifactTools,
  siteTools,
  readFileTool,
  listDirTool,
  grepSearchTool,
  editFileTool,
  writeFileTool,
  runShellTool,
  skillTool,
  runSubagentsTool,
  browserTools,
};
