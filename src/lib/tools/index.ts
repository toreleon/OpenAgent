import type { Tool } from "@openai/agents";
import { getCurrentTimeTool } from "./get-current-time";
import { runJavascriptTool } from "./run-javascript";
import { hostedWebSearchTool, webSearchFunctionTool } from "./web-search";
import { webFetchTool } from "./web-fetch";
import { artifactTools } from "./artifacts";

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
 */
export const agentTools: Tool[] = [
  ...(process.env.OPENAI_BASE_URL ? [] : [hostedWebSearchTool]),
  webSearchFunctionTool,
  webFetchTool,
  runJavascriptTool,
  getCurrentTimeTool,
  ...artifactTools,
];

export {
  getCurrentTimeTool,
  runJavascriptTool,
  hostedWebSearchTool,
  webSearchFunctionTool,
  webFetchTool,
  artifactTools,
};
