import fsp from "fs/promises";
import type { Plugin as PluginRow } from "@prisma/client";
import prisma from "@/lib/db";
import type { PluginDTO, PluginSkill, PluginSourceType } from "@/lib/types";
import type { InstallResult, ResolvedPluginInstall } from "./install";

/**
 * Database layer for installed plugins. Plugins live in the `Plugin` table with
 * their discovered skills cached as JSON in `skillsCache` (mirrors how
 * McpServer caches its tool list). A plugin's bundled remote MCP servers are
 * stored as ordinary `McpServer` rows tagged with `pluginId`, so they surface in
 * the existing Connectors UI — created disabled + untrusted so the user must
 * opt in before they ever load (loadUserMcpServers requires enabled+trusted).
 */

/** Parse the JSON `skillsCache` column into validated PluginSkill[]. */
export function parseSkills(cache: string | null): PluginSkill[] {
  if (!cache) return [];
  try {
    const arr = JSON.parse(cache);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (s): s is PluginSkill =>
          !!s &&
          typeof s === "object" &&
          typeof s.name === "string" &&
          typeof s.description === "string" &&
          typeof s.dir === "string",
      )
      .map((s) => ({
        name: s.name,
        description: s.description,
        dir: s.dir,
        enabled: s.enabled !== false,
      }));
  } catch {
    return [];
  }
}

function encodeSkills(skills: PluginSkill[]): string {
  return JSON.stringify(skills);
}

/** Map a Plugin row (+ its bundled-MCP count) to the sanitized DTO. */
export function toPluginDTO(row: PluginRow, mcpServerCount: number): PluginDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    version: row.version ?? undefined,
    author: row.author ?? undefined,
    sourceType: row.sourceType as PluginSourceType,
    sourceUrl: row.sourceUrl,
    gitRef: row.gitRef ?? undefined,
    marketplace: row.marketplace ?? undefined,
    enabled: row.enabled,
    skills: parseSkills(row.skillsCache),
    mcpServerCount,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Count bundled MCP servers per pluginId for a set of plugins. */
async function mcpCounts(pluginIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (pluginIds.length === 0) return counts;
  const grouped = await prisma.mcpServer.groupBy({
    by: ["pluginId"],
    where: { pluginId: { in: pluginIds } },
    _count: { _all: true },
  });
  for (const g of grouped) {
    if (g.pluginId) counts.set(g.pluginId, g._count._all);
  }
  return counts;
}

/** List a user's plugins, newest first, as DTOs. */
export async function listPlugins(userId: string): Promise<PluginDTO[]> {
  const rows = await prisma.plugin.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  const counts = await mcpCounts(rows.map((r) => r.id));
  return rows.map((r) => toPluginDTO(r, counts.get(r.id) ?? 0));
}

/**
 * Persist an install result: one Plugin row per resolved plugin, plus an
 * McpServer row per SUPPORTED bundled server. Warnings (skill parse issues +
 * skipped unsupported MCP servers) are folded into `lastError` for display.
 */
export interface InstallSourceMeta {
  sourceType: PluginSourceType;
  sourceUrl: string;
  gitRef: string | null;
}

export async function persistInstall(
  userId: string,
  install: InstallResult,
  source: InstallSourceMeta,
): Promise<PluginDTO[]> {
  // All Plugin + bundled-McpServer rows for this install are written in ONE
  // transaction, so a mid-loop failure rolls the whole set back and never
  // leaves an orphaned row pointing at an install dir the route's error path
  // then deletes. The clone/copy has already happened; these are fast inserts.
  const created = await prisma.$transaction(
    async (tx) => {
      const rows: { row: PluginRow; mcpCount: number }[] = [];
      for (const p of install.plugins) {
        const lastError = buildPluginNotice(p);
        const skills: PluginSkill[] = p.skills.map((s) => ({
          name: s.name,
          description: s.description,
          dir: s.dir,
          enabled: true,
        }));

        const row = await tx.plugin.create({
          data: {
            id: p.id,
            userId,
            name: p.name,
            description: p.description ?? null,
            version: p.version ?? null,
            author: p.author ?? null,
            sourceType: source.sourceType,
            sourceUrl: source.sourceUrl,
            gitRef: source.gitRef,
            marketplace: p.marketplace ?? null,
            installPath: p.installPath,
            skillsCache: encodeSkills(skills),
            enabled: true,
            lastError,
          },
        });

        // Bundled remote MCP servers (disabled + untrusted → opt-in only).
        let mcpCount = 0;
        for (const s of p.mcpServers) {
          if (!s.supported || !s.url) continue;
          await tx.mcpServer.create({
            data: {
              userId,
              name: `${p.name}/${s.name}`,
              url: s.url,
              description: `Bundled by plugin "${p.name}"`,
              enabled: false,
              trusted: false,
              authStatus: "pending",
              pluginId: p.id,
            },
          });
          mcpCount++;
        }

        rows.push({ row, mcpCount });
      }
      return rows;
    },
    { timeout: 20_000 },
  );

  return created.map(({ row, mcpCount }) => toPluginDTO(row, mcpCount));
}

/** Compose the per-plugin notice (skill warnings + skipped MCP servers). */
function buildPluginNotice(p: ResolvedPluginInstall): string | null {
  const notes: string[] = [...p.warnings];
  for (const s of p.mcpServers) {
    if (!s.supported) notes.push(`MCP server "${s.name}" skipped: ${s.reason}`);
  }
  return notes.length ? notes.join(" ") : null;
}

/** Toggle a whole plugin on/off. Returns the updated DTO, or null if not owned. */
export async function setPluginEnabled(
  userId: string,
  id: string,
  enabled: boolean,
): Promise<PluginDTO | null> {
  const row = await prisma.plugin.findFirst({ where: { id, userId } });
  if (!row) return null;
  const updated = await prisma.plugin.update({ where: { id }, data: { enabled } });
  const counts = await mcpCounts([id]);
  return toPluginDTO(updated, counts.get(id) ?? 0);
}

/** Toggle a single skill within a plugin. Returns the updated DTO, or null. */
export async function setSkillEnabled(
  userId: string,
  pluginId: string,
  skillName: string,
  enabled: boolean,
): Promise<PluginDTO | null> {
  const row = await prisma.plugin.findFirst({ where: { id: pluginId, userId } });
  if (!row) return null;
  const skills = parseSkills(row.skillsCache);
  const idx = skills.findIndex((s) => s.name === skillName);
  if (idx === -1) return null;
  skills[idx] = { ...skills[idx], enabled };
  const updated = await prisma.plugin.update({
    where: { id: pluginId },
    data: { skillsCache: encodeSkills(skills) },
  });
  const counts = await mcpCounts([pluginId]);
  return toPluginDTO(updated, counts.get(pluginId) ?? 0);
}

/**
 * Uninstall a plugin: delete its bundled MCP servers, delete the row, and
 * remove its install directory from disk. Returns false if not owned.
 */
export async function deletePlugin(userId: string, id: string): Promise<boolean> {
  const row = await prisma.plugin.findFirst({ where: { id, userId } });
  if (!row) return false;
  await prisma.mcpServer.deleteMany({ where: { pluginId: id, userId } });
  await prisma.plugin.delete({ where: { id } });
  // Best-effort disk cleanup; a failure here must not fail the uninstall.
  await fsp.rm(row.installPath, { recursive: true, force: true }).catch(() => {});
  return true;
}
