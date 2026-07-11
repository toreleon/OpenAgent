import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import prisma from "@/lib/db";
import {
  MAX_SKILLS_PROMPT_CHARS,
  MAX_SKILL_BODY_BYTES,
  MAX_SKILL_FILE_BYTES,
  type PluginSkill,
} from "@/lib/types";
import { parseSkills } from "./store";
import { resolveWithin } from "./paths";

/**
 * The two runtime touch-points for skills:
 *  1. {@link loadSkillsContext} — the LEVEL-1 progressive-disclosure block. Only
 *     each enabled skill's name + description goes into the system prompt (cheap),
 *     plus one instruction on how to pull a skill's full body via the `skill`
 *     tool. Composed by the chat route and appended after the base instructions.
 *  2. {@link loadSkillBody} / {@link readSkillFile} — LEVEL 2 (full SKILL.md) and
 *     LEVEL 3 (bundled resource files), served on demand to the `skill` tool.
 *     Every disk read is confined to the skill's own directory by resolveWithin.
 */

interface ResolvedSkill {
  skill: PluginSkill;
  pluginName: string;
  installPath: string;
}

/** Find an enabled skill by name across the user's enabled plugins (first
 *  match wins on a cross-plugin name collision). */
async function resolveSkill(
  userId: string,
  skillName: string,
): Promise<ResolvedSkill | null> {
  const rows = await prisma.plugin.findMany({
    where: { userId, enabled: true },
    orderBy: { createdAt: "asc" },
  });
  for (const row of rows) {
    const skills = parseSkills(row.skillsCache);
    const skill = skills.find((s) => s.enabled && s.name === skillName);
    if (skill) {
      return { skill, pluginName: row.name, installPath: row.installPath };
    }
  }
  return null;
}

/** All enabled skills across the user's enabled plugins, in stable order. */
async function enabledSkills(userId: string): Promise<
  Array<{ skill: PluginSkill; pluginName: string }>
> {
  const rows = await prisma.plugin.findMany({
    where: { userId, enabled: true },
    orderBy: { createdAt: "asc" },
  });
  const out: Array<{ skill: PluginSkill; pluginName: string }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const skill of parseSkills(row.skillsCache)) {
      if (!skill.enabled) continue;
      if (seen.has(skill.name)) continue; // first plugin wins the name
      seen.add(skill.name);
      out.push({ skill, pluginName: row.name });
    }
  }
  return out;
}

/**
 * Build the LEVEL-1 skills block for the system prompt, or null when the user
 * has no enabled skills. Never throws — a DB error degrades to null so chat is
 * never broken by skill loading (mirrors loadProjectContext).
 */
export async function loadSkillsContext(userId: string): Promise<string | null> {
  let skills: Array<{ skill: PluginSkill; pluginName: string }>;
  try {
    skills = await enabledSkills(userId);
  } catch (err) {
    console.error("[plugins] failed to load skills context:", err);
    return null;
  }
  if (skills.length === 0) return null;

  const lines: string[] = [];
  let budget = MAX_SKILLS_PROMPT_CHARS;
  let omitted = 0;
  for (const { skill } of skills) {
    const line = `- ${skill.name}: ${skill.description}`;
    if (line.length > budget) {
      omitted++;
      continue;
    }
    budget -= line.length;
    lines.push(line);
  }

  const header =
    "=== Available skills ===\n" +
    "You have installed skills — expert playbooks for specific tasks. Each is listed " +
    "below as `name: description`. When the user's request matches a skill's description, " +
    "call the `skill` tool with that skill's `name` to load its full instructions BEFORE " +
    "you attempt the task, then follow them. A skill may reference bundled files; read one " +
    "by calling `skill` again with both `name` and the file's relative `path`. Only use a " +
    "skill when it clearly fits; otherwise answer normally.";

  let footer = "";
  if (omitted > 0) {
    footer = `\n(+${omitted} more skill${omitted === 1 ? "" : "s"} not shown for length.)`;
  }

  return `${header}\n\n${lines.join("\n")}${footer}\n=== End available skills ===`;
}

// ---- skill tool backend ---------------------------------------------------

export interface SkillBodyResult {
  ok: true;
  name: string;
  plugin: string;
  body: string;
  truncated: boolean;
  /** Relative paths of bundled resource files (excludes SKILL.md). */
  files: string[];
}

export interface SkillFileResult {
  ok: true;
  name: string;
  path: string;
  content: string;
  truncated: boolean;
}

export interface SkillError {
  ok: false;
  error: string;
}

/** Canonical (realpath'd) root dir of a resolved skill, CONFINED to the plugin
 *  install dir. `dir` comes from the persisted skillsCache; jailing it here with
 *  resolveWithin is defense-in-depth so a maliciously-escaping `dir` (e.g. from
 *  a crafted manifest) can never make a read land outside the install dir, even
 *  if discovery-time validation were bypassed. Throws on escape or missing dir. */
function skillRoot(installPath: string, dir: string): string {
  const realInstall = fs.realpathSync(installPath);
  if (dir === ".") return realInstall;
  const confined = resolveWithin(realInstall, dir);
  return fs.realpathSync(confined);
}

/** Shallow list of bundled files under a skill dir (excludes SKILL.md, .git,
 *  and symlinks). Capped in depth + count so a huge skill can't flood context. */
function listSkillFiles(root: string): string[] {
  const out: string[] = [];
  const MAX = 200;
  const MAX_DEPTH = 4;
  const walk = (dir: string, rel: string, depth: number) => {
    if (out.length >= MAX || depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX) return;
      if (e.name === ".git" || e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), childRel, depth + 1);
      } else if (e.isFile()) {
        if (childRel === "SKILL.md") continue;
        out.push(childRel);
      }
    }
  };
  walk(root, "", 0);
  return out.sort();
}

/** LEVEL 2: return a skill's full SKILL.md body + a manifest of bundled files. */
export async function loadSkillBody(
  userId: string,
  skillName: string,
): Promise<SkillBodyResult | SkillError> {
  const resolved = await resolveSkill(userId, skillName);
  if (!resolved) {
    return { ok: false, error: `No enabled skill named "${skillName}" is installed.` };
  }
  let root: string;
  try {
    root = skillRoot(resolved.installPath, resolved.skill.dir);
  } catch {
    return { ok: false, error: `Skill "${skillName}" is no longer available on disk.` };
  }

  let abs: string;
  try {
    abs = resolveWithin(root, "SKILL.md");
  } catch {
    return { ok: false, error: `Skill "${skillName}" has no readable SKILL.md.` };
  }

  let buf: Buffer;
  try {
    buf = await fsp.readFile(abs);
  } catch {
    return { ok: false, error: `Could not read SKILL.md for "${skillName}".` };
  }
  const truncated = buf.length > MAX_SKILL_BODY_BYTES;
  const body = buf.subarray(0, MAX_SKILL_BODY_BYTES).toString("utf8");

  return {
    ok: true,
    name: resolved.skill.name,
    plugin: resolved.pluginName,
    body,
    truncated,
    files: listSkillFiles(root),
  };
}

/** LEVEL 3: return one bundled resource file's contents, jailed to the skill dir. */
export async function readSkillFile(
  userId: string,
  skillName: string,
  relPath: string,
): Promise<SkillFileResult | SkillError> {
  const resolved = await resolveSkill(userId, skillName);
  if (!resolved) {
    return { ok: false, error: `No enabled skill named "${skillName}" is installed.` };
  }
  let root: string;
  try {
    root = skillRoot(resolved.installPath, resolved.skill.dir);
  } catch {
    return { ok: false, error: `Skill "${skillName}" is no longer available on disk.` };
  }

  let abs: string;
  try {
    abs = resolveWithin(root, relPath);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid path." };
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return { ok: false, error: `File not found in skill "${skillName}": ${relPath}` };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `Not a file: ${relPath}` };
  }

  const buf = await fsp.readFile(abs);
  // Reject obviously-binary content (NUL byte in the first 8KB).
  if (buf.subarray(0, 8192).includes(0)) {
    return {
      ok: false,
      error: `"${relPath}" looks like a binary file; skill files opened this way must be text.`,
    };
  }
  const truncated = buf.length > MAX_SKILL_FILE_BYTES;
  const content = buf.subarray(0, MAX_SKILL_FILE_BYTES).toString("utf8");
  return { ok: true, name: resolved.skill.name, path: relPath, content, truncated };
}
