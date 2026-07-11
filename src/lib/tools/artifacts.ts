import { tool } from "@openai/agents";
import { z } from "zod";
import type { Tool } from "@openai/agents";

/**
 * The artifact tools. These are "capture" tools: their job is to carry the
 * artifact payload out of the model. The actual persistence + versioning + live
 * streaming to the panel is performed by the /api/chat route, which intercepts
 * these tool calls (see src/lib/artifacts.ts). The `execute` implementations
 * therefore do NO database work — they only return an acknowledgement string
 * that tells the model the artifact was shown to the user and how to iterate.
 *
 * Keep the tool `name` values in sync with ARTIFACT_TOOL_NAMES in @/lib/types.
 */

const TYPE_DESCRIPTION =
  "The artifact kind: 'code' (syntax-highlighted source; also set `language`), " +
  "'markdown' (a rich text document), 'html' (a self-contained web page rendered " +
  "in a sandboxed iframe), 'svg' (an SVG image), 'image' (an image or data URL), " +
  "'mermaid' (a Mermaid diagram), or " +
  "'react' (a self-contained interactive React component with a default export).";

export const createArtifactTool: Tool = tool({
  name: "create_artifact",
  description:
    "Create a new artifact shown to the user in a side panel. Use for substantial, " +
    "self-contained, reusable content the user will likely edit, reuse, or preview: " +
    "code files (>15 lines), full documents, HTML pages, SVG/diagrams, or interactive " +
    "React components. Do NOT use for short snippets, explanations, or conversational " +
    "replies. After creating, do not repeat the artifact's full content in your message.",
  parameters: z.object({
    identifier: z
      .string()
      .describe(
        "A short, stable, kebab-case identifier for this artifact (e.g. " +
          "'todo-app'). Reuse the SAME identifier with update_artifact / " +
          "rewrite_artifact to revise it.",
      ),
    type: z
      .enum(["code", "markdown", "html", "svg", "image", "mermaid", "react"])
      .describe(TYPE_DESCRIPTION),
    title: z
      .string()
      .describe("A concise human-readable title shown in the panel header."),
    language: z
      .string()
      .nullable()
      .optional()
      .describe(
        "For type='code' only: the source language (e.g. 'python', 'typescript'). " +
          "Omit or null for other types.",
      ),
    content: z
      .string()
      .describe(
        "The FULL artifact content. For 'react', export the root component as the " +
          "default export and import any libraries (react, recharts, lucide-react) " +
          "normally. For 'html', output a complete, self-contained document.",
      ),
  }),
  async execute({ identifier }) {
    return (
      `Created artifact "${identifier}" and displayed it to the user in the side panel. ` +
      "Do not paste its contents into your reply. To revise it, call update_artifact " +
      "(for small edits) or rewrite_artifact (to replace it) with the same identifier."
    );
  },
});

export const updateArtifactTool: Tool = tool({
  name: "update_artifact",
  description:
    "Make a small, targeted edit to an existing artifact by replacing an exact " +
    "substring. Prefer this over rewrite_artifact for localized changes. The " +
    "`old_str` must appear EXACTLY ONCE in the current content; if unsure, use " +
    "rewrite_artifact instead.",
  parameters: z.object({
    identifier: z
      .string()
      .describe("The identifier of the artifact to edit (as used when it was created)."),
    old_str: z
      .string()
      .describe(
        "The exact, unique substring in the current content to replace. Include " +
          "enough surrounding context to make it unambiguous.",
      ),
    new_str: z
      .string()
      .describe("The replacement text for `old_str`."),
  }),
  async execute({ identifier }) {
    return `Updated artifact "${identifier}"; the new version is shown to the user.`;
  },
});

export const rewriteArtifactTool: Tool = tool({
  name: "rewrite_artifact",
  description:
    "Replace the entire content of an existing artifact with a new version. Use " +
    "for large or structural changes (or when update_artifact's old_str would be " +
    "ambiguous). Provide the complete new content.",
  parameters: z.object({
    identifier: z
      .string()
      .describe("The identifier of the artifact to rewrite."),
    title: z
      .string()
      .nullable()
      .optional()
      .describe("Optionally update the artifact's title."),
    content: z
      .string()
      .describe("The FULL new content that fully replaces the previous version."),
  }),
  async execute({ identifier }) {
    return `Rewrote artifact "${identifier}"; the new version is shown to the user.`;
  },
});

/** All artifact tools, registered together in the agent's tool set. */
export const artifactTools: Tool[] = [
  createArtifactTool,
  updateArtifactTool,
  rewriteArtifactTool,
];
