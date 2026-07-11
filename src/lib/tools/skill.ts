import { tool } from "@openai/agents";
import { z } from "zod";
import { userIdFromContext } from "@/lib/sandbox/confine";
import { loadSkillBody, readSkillFile } from "@/lib/plugins/context";

/**
 * The `skill` tool implements Claude-style progressive disclosure for installed
 * plugin skills. The system prompt lists only each enabled skill's name +
 * description (level 1); this tool loads a skill's full SKILL.md body on demand
 * (level 2), and reads a bundled resource file when called with a `path`
 * (level 3). Every read is confined to the skill's own directory.
 *
 * The owning userId is read from the Agents SDK RunContext (threaded in
 * src/lib/agent.ts), never from a model argument, so a run can only reach its
 * own user's skills.
 */
export const skillTool = tool({
  name: "skill",
  description:
    "Load an installed skill's full instructions before doing a task that matches " +
    "it. Call with the skill's `name` (as shown in the Available skills list) to get " +
    "its complete SKILL.md guidance plus a list of any bundled files. To read one of " +
    "those bundled files (a reference doc, template, or script), call again with the " +
    "same `name` and the file's relative `path`. Then follow the skill's instructions.",
  parameters: z.object({
    name: z
      .string()
      .describe("The skill's name, exactly as listed under 'Available skills'."),
    path: z
      .string()
      .nullable()
      .describe(
        "Optional. A bundled file's path relative to the skill directory (e.g. " +
          "'references/FORMS.md'). Omit (null) to load the skill's SKILL.md body.",
      ),
  }),
  async execute({ name, path }, ctx) {
    const userId = userIdFromContext(ctx);
    if (!userId) {
      return {
        ok: false as const,
        error: "No user is bound to this run, so skills are unavailable.",
      };
    }

    const skillName = typeof name === "string" ? name.trim() : "";
    if (!skillName) {
      return { ok: false as const, error: "A skill `name` is required." };
    }

    // Normalize the path so the model can be sloppy: strip leading "./" and a
    // stray absolute "/" (it means "relative to the skill root"), and treat an
    // empty path OR a request for the skill's own SKILL.md as a body load.
    let relPath = typeof path === "string" ? path.trim() : "";
    relPath = relPath.replace(/^\.?\/+/, "");
    if (!relPath || relPath.toLowerCase() === "skill.md") {
      return loadSkillBody(userId, skillName);
    }
    return readSkillFile(userId, skillName, relPath);
  },
});
