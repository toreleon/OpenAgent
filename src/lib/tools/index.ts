import type { Tool } from "@openai/agents";
import { getCurrentTimeTool } from "./get-current-time";
import { runJavascriptTool } from "./run-javascript";
import { hostedWebSearchTool, fallbackWebSearchTool } from "./web-search";
import { artifactTools } from "./artifacts";

/**
 * The full set of tools available to the chat agent. Order is not significant;
 * the model chooses which (if any) to call.
 *
 * The hosted web-search tool serializes as the OpenAI `web_search_preview` tool
 * type, which is only supported by the public OpenAI Responses API. Azure /
 * OpenAI-compatible endpoints reject unknown tool types and would 400 the entire
 * request, so we only register it when no custom `OPENAI_BASE_URL` is set. The
 * dependency-free fallback always remains so search still works everywhere.
 */
export const agentTools: Tool[] = [
  ...(process.env.OPENAI_BASE_URL ? [] : [hostedWebSearchTool]),
  fallbackWebSearchTool,
  runJavascriptTool,
  getCurrentTimeTool,
  ...artifactTools,
];

export {
  getCurrentTimeTool,
  runJavascriptTool,
  hostedWebSearchTool,
  fallbackWebSearchTool,
  artifactTools,
};
