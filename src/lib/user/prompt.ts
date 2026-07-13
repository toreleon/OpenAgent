/**
 * Global custom instructions ("Customize OpenAgent") composed into the system
 * prompt for every chat when enabled. The chat route loads this via
 * {@link loadUserContext} and merges it with any project context before passing
 * it to the agent — mirroring src/lib/projects/prompt.ts.
 */
import type { PrismaClient } from "@prisma/client";
import { EMPTY_CUSTOM_INSTRUCTIONS, type CustomInstructions } from "@/lib/types";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Parse the JSON `User.customInstructions` column into a full CustomInstructions. */
export function parseCustomInstructions(raw: string | null): CustomInstructions {
  if (!raw) return { ...EMPTY_CUSTOM_INSTRUCTIONS };
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      nickname: str(o.nickname),
      occupation: str(o.occupation),
      traits: str(o.traits),
      about: str(o.about),
      // Default to enabled unless explicitly false.
      enabled: o.enabled !== false,
    };
  } catch {
    return { ...EMPTY_CUSTOM_INSTRUCTIONS };
  }
}

/** Compose custom instructions into a system-prompt block, or null when nothing to inject. */
export function composeUserContext(ci: CustomInstructions | null): string | null {
  if (!ci || !ci.enabled) return null;
  const lines: string[] = [];
  if (ci.nickname.trim()) lines.push(`- What to call the user: ${ci.nickname.trim()}`);
  if (ci.occupation.trim()) lines.push(`- What the user does: ${ci.occupation.trim()}`);
  if (ci.traits.trim())
    lines.push(`- How the user wants you to respond: ${ci.traits.trim()}`);
  if (ci.about.trim()) lines.push(`- Other context about the user: ${ci.about.trim()}`);
  if (lines.length === 0) return null;
  return `The user has set custom instructions. Keep them in mind and apply them across the whole conversation:\n${lines.join("\n")}`;
}

/**
 * Load the user's custom instructions and compose their system-prompt block.
 * Never throws — a DB error degrades to null so chat is never broken.
 */
export async function loadUserContext(
  prisma: PrismaClient,
  userId: string,
): Promise<string | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { customInstructions: true },
    });
    return composeUserContext(parseCustomInstructions(user?.customInstructions ?? null));
  } catch (err) {
    console.error("[user] failed to load custom instructions:", err);
    return null;
  }
}
