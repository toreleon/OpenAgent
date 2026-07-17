import { tool } from "@openai/agents";
import { z } from "zod";
import type { Tool } from "@openai/agents";
import prisma from "@/lib/db";
import { userIdFromContext, conversationIdFromContext } from "@/lib/sandbox/confine";
import { isSiteType } from "@/lib/types";

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

// NOTE: 'code' is deliberately NOT a creatable kind (Claude-Code-style artifacts:
// an artifact is a RENDERED capture — page/document/diagram/app — never raw
// source). Code answers belong in fenced markdown blocks or workspace files. The
// DATA layer still accepts 'code' so historical code artifacts keep rendering.
const TYPE_DESCRIPTION =
  "The artifact kind: 'markdown' (a rich text document), 'html' (a self-contained " +
  "web page rendered in a sandboxed iframe), 'svg' (an SVG image), 'image' (an " +
  "image or data URL), 'mermaid' (a Mermaid diagram), " +
  "'react' (a self-contained interactive React component with a default export), or " +
  "'mobile' (a self-contained React Native app — a real mobile app previewed live " +
  "in a phone frame via react-native-web). Use 'mobile' when the user asks for a " +
  "MOBILE / iOS / Android / phone app; use 'react' for a web app or web UI. " +
  "There is NO 'code' kind — never make an artifact out of plain source code.";

export const createArtifactTool: Tool = tool({
  name: "create_artifact",
  description:
    "Create a new artifact shown to the user in a side panel: a RENDERED, " +
    "self-contained deliverable — a rich document, complete web page, SVG image, " +
    "Mermaid diagram, or interactive React app — that the user will view, keep, or " +
    "publish. NEVER use an artifact for source code: code answers of ANY length " +
    "belong in fenced Markdown blocks in your reply (or in workspace files via " +
    "write_file for coding tasks); wrapping plain code in a 'markdown' or 'html' " +
    "artifact is also wrong. Do NOT use for short snippets or conversational " +
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
      .enum(["markdown", "html", "svg", "image", "mermaid", "react", "mobile"])
      .describe(TYPE_DESCRIPTION),
    title: z
      .string()
      .describe("A concise human-readable title shown in the panel header."),
    content: z
      .string()
      .describe(
        "The FULL artifact content. For 'react', export the root component as the " +
          "default export and import any libraries (react, recharts, lucide-react) " +
          "normally. For 'mobile', write a single-file React Native app: export the " +
          "root component as the default export and import from 'react-native' " +
          "(View, Text, StyleSheet, ScrollView, Pressable, TextInput, FlatList, …). " +
          "For 'html', output a complete, self-contained document.",
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

export const publishArtifactTool: Tool = tool({
  name: "publish_artifact",
  description:
    "Publish an existing artifact to a durable, shareable PUBLIC URL — the way to " +
    "turn a preview into a real, linkable page/app. Use when the user asks to " +
    "publish, share, deploy, or make a link for an artifact they can send to others. " +
    "Publishing again with the same identifier updates the SAME live URL to the " +
    "latest version. Whether it goes fully live is gated by the user's auto-publish " +
    "opt-in; otherwise it saves a deployable version for the user to publish with " +
    "one click.",
  parameters: z.object({
    identifier: z
      .string()
      .describe(
        "The identifier of the artifact to publish (as used when it was created).",
      ),
  }),
  async execute({ identifier }, ctx) {
    const userId = userIdFromContext(ctx);
    const conversationId = conversationIdFromContext(ctx);
    // Run the SAME read-only guards the server-side publishArtifact will (the real
    // work happens in /api/chat, which only console.errors on failure), so the
    // model-facing ack matches what actually happens. Read-only — no mutation — so
    // it is safe to run concurrently with the route's real publish (which resolves
    // the artifact again). We deliberately do NOT call publishArtifact here: that
    // would race the route and create a duplicate shadow Site.
    if (userId && conversationId && identifier) {
      const artifact = await prisma.artifact.findFirst({
        where: { conversationId, identifier, conversation: { userId } },
        include: { versions: { orderBy: { version: "desc" }, take: 1 } },
      });
      if (!artifact) {
        return (
          `Could not find an artifact "${identifier}" to publish. Ask the user which ` +
          "artifact to publish (use the identifier from when it was created); nothing was published."
        );
      }
      if (!isSiteType(artifact.type)) {
        return (
          `The "${identifier}" artifact is type "${artifact.type}", which can't be published — ` +
          "only html, react, mobile, markdown, svg, or mermaid can. Nothing was published."
        );
      }
      if (!artifact.versions[0]) {
        return `The "${identifier}" artifact has no content yet, so there is nothing to publish.`;
      }
    }
    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { sitesAutoDeploy: true },
      });
      if (user?.sitesAutoDeploy) {
        return (
          "Auto-publish is on — published the artifact to its live public URL, shown " +
          "in the panel. Tell the user it's now live and share the link."
        );
      }
    }
    return (
      "Saved the artifact as a deployable version but did NOT make it public (the " +
      "user hasn't enabled auto-publish). Ask the user to click Publish in the " +
      "artifact panel to make it live, or to enable auto-publish in settings."
    );
  },
});

/** All artifact tools, registered together in the agent's tool set. */
export const artifactTools: Tool[] = [
  createArtifactTool,
  updateArtifactTool,
  rewriteArtifactTool,
  publishArtifactTool,
];
