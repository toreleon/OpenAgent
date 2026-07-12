import { tool } from "@openai/agents";
import { z } from "zod";
import type { Tool } from "@openai/agents";
import prisma from "@/lib/db";
import { userIdFromContext } from "@/lib/sandbox/confine";

/**
 * The Site tools (ChatGPT-Sites-style publishing). Like the artifact tools these
 * are mostly "capture" tools: create_site / update_site carry the page payload
 * out of the model, and the /api/chat route intercepts them to persist the draft,
 * version it, and stream a `site` event to the panel (see src/lib/sites.ts).
 *
 * deploy_site is special: whether it actually publishes depends on the user's
 * `sitesAutoDeploy` opt-in, so its `execute` reads the RunContext userId and
 * returns an ACCURATE acknowledgement (the model must know whether it published
 * or merely saved a candidate). The real DB work still happens in the chat route.
 *
 * Keep the tool `name` values in sync with SITE_TOOL_NAMES in @/lib/types.
 */

const SITE_TYPE_DESCRIPTION =
  "The page kind: 'html' (a self-contained web page), 'react' (an interactive " +
  "React component with a default export), 'markdown' (a rich text document), " +
  "'svg' (an SVG image), or 'mermaid' (a diagram). All render in an isolated, " +
  "sandboxed context when published.";

export const createSiteTool: Tool = tool({
  name: "create_site",
  description:
    "Build (or replace) a publishable Site — a standalone web page/app served at " +
    "its own public URL, separate from this chat. Use when the user wants a real, " +
    "shareable site, web app, landing page, dashboard, or game (not a throwaway " +
    "snippet). Calling create_site again in the same chat replaces the current " +
    "site's DRAFT. Editing the draft does NOT publish it — the site only goes live " +
    "when it is deployed. For a site that must REMEMBER data across visitors (guestbook, poll, " +
    "counter, saved state, submissions), also pass the `backend` manifest and have the page use the " +
    "injected `Sites` API — that is what makes a Site a real mini-app rather than a static page. " +
    "After creating, don't paste the full content into your reply.",
  parameters: z.object({
    name: z
      .string()
      .describe("A short human-readable name for the site (e.g. 'Launch Countdown')."),
    type: z
      .enum(["html", "react", "markdown", "svg", "mermaid"])
      .describe(SITE_TYPE_DESCRIPTION),
    content: z
      .string()
      .describe(
        "The FULL page content. For 'html' output a complete self-contained document; " +
          "for 'react' export the root component as the default export.",
      ),
    language: z
      .string()
      .nullable()
      .optional()
      .describe("Unused for sites; leave null."),
    backend: z
      .object({
        kv: z
          .boolean()
          .nullable()
          .optional()
          .describe("Enable a per-site key/value store for shared state (counters, saved settings)."),
        collections: z
          .array(z.string())
          .nullable()
          .optional()
          .describe(
            "Names of append-only document collections to enable, e.g. ['guestbook','signups'].",
          ),
      })
      .nullable()
      .optional()
      .describe(
        "Declare a SERVER BACKEND so the site can persist shared, cross-visitor data. Omit for a " +
          "static site. When set, the page may call the injected `Sites` API (available as " +
          "window.Sites): `await Sites.kv.get(collection, key)` / `await Sites.kv.put(collection, " +
          "key, value)` and `await Sites.docs.append(collection, obj)` / `await Sites.docs.list(" +
          "collection)`. All data is SHARED and PUBLIC — anyone with the link can read AND write it, " +
          "so never store secrets or private/personal info. Do NOT use localStorage for shared state; " +
          "use the Sites API. The backend serves only once the site is deployed.",
      ),
  }),
  async execute({ name }) {
    return (
      `Saved the draft for site "${name}" and showed it to the user in the Sites panel. ` +
      "Editing the draft does not publish it. To revise, call update_site (small edits) " +
      "or create_site (full replace). To publish it to its live URL, call deploy_site " +
      "(only works if the user enabled auto-deploy) or ask the user to click Deploy."
    );
  },
});

export const updateSiteTool: Tool = tool({
  name: "update_site",
  description:
    "Make a small, targeted edit to the current site's DRAFT by replacing an exact " +
    "substring. Prefer this over create_site for localized changes. `old_str` must " +
    "appear EXACTLY ONCE in the current draft; if unsure, use create_site to replace " +
    "the whole page. Does not publish — the change stays in the draft until deploy.",
  parameters: z.object({
    old_str: z
      .string()
      .describe(
        "The exact, unique substring in the current draft to replace. Include enough " +
          "surrounding context to make it unambiguous.",
      ),
    new_str: z.string().describe("The replacement text for `old_str`."),
  }),
  async execute() {
    return "Updated the site draft; the new version is shown to the user in the Sites panel.";
  },
});

export const deploySiteTool: Tool = tool({
  name: "deploy_site",
  description:
    "Publish the current site's draft to its LIVE public URL (a production deploy). " +
    "This only takes effect if the user has enabled auto-deploy; otherwise it saves a " +
    "deployable version and the user must click Deploy themselves. Use after the site " +
    "looks right and the user has asked to publish/share it.",
  parameters: z.object({
    confirm: z
      .boolean()
      .nullable()
      .optional()
      .describe("Optional; set true to indicate the user asked to publish."),
  }),
  async execute(_args, ctx) {
    const userId = userIdFromContext(ctx);
    if (!userId) {
      return "Could not resolve the current user; the site was not published.";
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { sitesAutoDeploy: true },
    });
    if (user?.sitesAutoDeploy) {
      return (
        "Auto-deploy is enabled — published the current draft to the site's live public " +
        "URL. The live URL is shown in the Sites panel. Tell the user it's now live."
      );
    }
    return (
      "Auto-deploy is OFF, so I saved the current draft as a deployable version but did " +
      "NOT publish it. Ask the user to click Deploy in the Sites panel to make it live " +
      "(or to enable auto-deploy in settings)."
    );
  },
});

/** All site tools, registered together in the agent's tool set. */
export const siteTools: Tool[] = [createSiteTool, updateSiteTool, deploySiteTool];
