import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { nanoid } from "nanoid";
import type { PluginSourceType } from "@/lib/types";
import { cloneRepo, GitCloneError } from "./git";
import {
  discoverPlugin,
  looksLikePlugin,
  parseMarketplace,
  type DiscoveredMcpServer,
  type DiscoveredSkill,
  type MarketplaceEntry,
} from "./discover";
import { pluginInstallDir, pluginTmpDir, pluginsRoot } from "./paths";

/**
 * Fetch a plugin source (git repo or local folder), figure out whether it's a
 * marketplace (many plugins) or a single plugin, discover each plugin's skills
 * + bundled MCP servers, and copy each plugin's tree into its own permanent
 * install dir. Returns pure data for src/lib/plugins/store.ts to persist.
 *
 * Everything under a scratch `.tmp-*` dir is removed before returning. The copy
 * step skips `.git/` and symlinks and is size/count-capped, so a hostile or
 * huge repo can't fill the disk or smuggle a symlink escape into the install.
 */

export class PluginInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginInstallError";
  }
}

export interface ResolvedPluginInstall {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  marketplace?: string;
  /** Absolute permanent install dir (.plugins/<userId>/<id>). */
  installPath: string;
  skills: DiscoveredSkill[];
  mcpServers: DiscoveredMcpServer[];
  warnings: string[];
}

export interface InstallResult {
  plugins: ResolvedPluginInstall[];
  warnings: string[];
}

const MAX_COPY_BYTES = 64 * 1024 * 1024; // 64MB per plugin
const MAX_COPY_FILES = 20_000;
const MAX_MARKETPLACE_PLUGINS = 100;

// ---- source fetch ---------------------------------------------------------

/** Copy a directory tree, skipping `.git/` and symlinks, capping total bytes +
 *  file count. Never follows a symlink out of the tree. */
async function copyTree(src: string, dest: string): Promise<void> {
  let bytes = 0;
  let files = 0;

  const walk = async (from: string, to: string) => {
    await fsp.mkdir(to, { recursive: true });
    const entries = await fsp.readdir(from, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === ".git") continue;
      const s = path.join(from, e.name);
      const d = path.join(to, e.name);
      if (e.isSymbolicLink()) continue; // never copy symlinks
      if (e.isDirectory()) {
        await walk(s, d);
      } else if (e.isFile()) {
        const st = await fsp.stat(s);
        bytes += st.size;
        files += 1;
        if (files > MAX_COPY_FILES) {
          throw new PluginInstallError(
            `Plugin has too many files (>${MAX_COPY_FILES}); refusing to install.`,
          );
        }
        if (bytes > MAX_COPY_BYTES) {
          throw new PluginInstallError(
            `Plugin is too large (>${Math.round(MAX_COPY_BYTES / 1024 / 1024)}MB); refusing to install.`,
          );
        }
        await fsp.copyFile(s, d);
      }
    }
  };

  await walk(src, dest);
}

/**
 * Resolve a source to a directory we can parse. A git source is cloned into a
 * throwaway temp dir (returned as `cleanup`); a LOCAL source is read IN PLACE —
 * we never copy the whole tree up front (only each discovered plugin is copied
 * into its install dir later), and never touch the user's original folder.
 */
async function resolveSourceDir(
  sourceType: PluginSourceType,
  source: string,
  ref: string | undefined,
  userId: string,
): Promise<{ dir: string; cleanup?: string }> {
  if (sourceType === "git") {
    const dest = pluginTmpDir(userId, nanoid());
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await cloneRepo({ url: source, ref, dest });
    } catch (err) {
      await rmrf(dest);
      throw err;
    }
    return { dir: dest, cleanup: dest };
  }
  // local — parse in place
  const abs = path.resolve(source);
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(abs);
  } catch {
    throw new PluginInstallError(`Local path does not exist: ${source}`);
  }
  if (!stat.isDirectory()) {
    throw new PluginInstallError(`Local path is not a directory: ${source}`);
  }
  // Guard against pointing at the plugins root itself (would recurse).
  const root = pluginsRoot();
  if (abs === root || abs.startsWith(root + path.sep)) {
    throw new PluginInstallError("Refusing to install from inside the plugins directory.");
  }
  return { dir: abs };
}

// ---- marketplace entry resolution -----------------------------------------

interface ResolvedEntryDir {
  rootDir: string;
  name: string;
  description?: string;
  version?: string;
  /** A nested clone dir to clean up afterwards, if any. */
  cleanup?: string;
}

/** Resolve one marketplace plugin entry to an on-disk plugin root, cloning
 *  nested git sources as needed. Returns null (with a warning pushed) when the
 *  source form is unsupported or escapes the repo. */
async function resolveEntry(
  entry: MarketplaceEntry,
  repoRoot: string,
  pluginRootPrefix: string | undefined,
  userId: string,
  warnings: string[],
): Promise<ResolvedEntryDir | null> {
  const src = entry.source;

  // Relative-path source (string) → subdir of the repo. A `./`-prefixed source
  // is already relative to the marketplace root, so metadata.pluginRoot is NOT
  // prepended (the official examples pair `pluginRoot: "./plugins"` with a full
  // `source: "./plugins/foo"`). A bare name gets pluginRoot prepended.
  if (typeof src === "string") {
    const isDotRel = src.startsWith("./");
    const rel = src.replace(/^\.\//, "");
    const combined =
      !isDotRel && pluginRootPrefix
        ? path.join(pluginRootPrefix.replace(/^\.\//, ""), rel)
        : rel;
    const abs = path.resolve(repoRoot, combined);
    if (abs !== repoRoot && !abs.startsWith(repoRoot + path.sep)) {
      warnings.push(`Skipped "${entry.name}": source path escapes the marketplace repo.`);
      return null;
    }
    if (!fs.existsSync(abs)) {
      warnings.push(`Skipped "${entry.name}": source path "${src}" not found in the repo.`);
      return null;
    }
    return { rootDir: abs, name: entry.name, description: entry.description, version: entry.version };
  }

  if (typeof src !== "object" || src === null) {
    warnings.push(`Skipped "${entry.name}": unrecognized source.`);
    return null;
  }

  const o = src as Record<string, unknown>;
  const kind = typeof o.source === "string" ? o.source : undefined;
  const ref =
    (typeof o.sha === "string" && o.sha) ||
    (typeof o.ref === "string" && o.ref) ||
    undefined;

  let url: string | undefined;
  let subpath: string | undefined;
  if (kind === "github" && typeof o.repo === "string") {
    url = `https://github.com/${o.repo.replace(/\.git$/, "")}.git`;
  } else if (kind === "url" && typeof o.url === "string") {
    url = o.url;
  } else if (kind === "git-subdir" && typeof o.url === "string" && typeof o.path === "string") {
    url = o.url;
    subpath = o.path;
  } else {
    warnings.push(
      `Skipped "${entry.name}": ${kind ? `"${kind}"` : "this"} source type is not supported (use a relative path, github, url, or git-subdir).`,
    );
    return null;
  }

  const nestedDir = pluginTmpDir(userId, nanoid());
  try {
    await cloneRepo({ url, ref, dest: nestedDir });
  } catch (err) {
    await rmrf(nestedDir);
    warnings.push(
      `Skipped "${entry.name}": ${err instanceof GitCloneError ? err.message : "clone failed"}`,
    );
    return null;
  }

  let rootDir = nestedDir;
  if (subpath) {
    const abs = path.resolve(nestedDir, subpath.replace(/^\.\//, ""));
    if (abs !== nestedDir && !abs.startsWith(nestedDir + path.sep)) {
      await rmrf(nestedDir);
      warnings.push(`Skipped "${entry.name}": git-subdir path escapes the repo.`);
      return null;
    }
    rootDir = abs;
  }
  return {
    rootDir,
    name: entry.name,
    description: entry.description,
    version: entry.version,
    cleanup: nestedDir,
  };
}

// ---- orchestration --------------------------------------------------------

async function rmrf(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Derive a plugin name from a git URL or local path (last path segment). */
function nameFromSource(source: string): string {
  const cleaned = source.replace(/\.git$/, "").replace(/\/+$/, "");
  const seg = cleaned.split(/[\\/]/).filter(Boolean).pop() || "plugin";
  return seg;
}

export async function installFromSource(params: {
  userId: string;
  sourceType: PluginSourceType;
  source: string;
  ref?: string;
}): Promise<InstallResult> {
  const { userId, sourceType, source, ref } = params;
  const warnings: string[] = [];
  const nestedCleanups: string[] = [];

  // Clone (git) into a temp dir, or read a local source in place. `srcCleanup`
  // is the git clone to remove afterwards; for local it is undefined so we never
  // touch the user's own folder.
  const { dir: srcDir, cleanup: srcCleanup } = await resolveSourceDir(
    sourceType,
    source,
    ref,
    userId,
  );
  if (srcCleanup) nestedCleanups.push(srcCleanup);

  try {
    // Marketplace vs single plugin.
    const marketplace = parseMarketplace(srcDir);
    const resolvedDirs: ResolvedEntryDir[] = [];

    if (marketplace) {
      if (marketplace.entries.length === 0) {
        throw new PluginInstallError("The marketplace lists no plugins.");
      }
      const entries = marketplace.entries.slice(0, MAX_MARKETPLACE_PLUGINS);
      if (marketplace.entries.length > entries.length) {
        warnings.push(
          `Marketplace lists ${marketplace.entries.length} plugins; installing the first ${entries.length}.`,
        );
      }
      for (const entry of entries) {
        const resolved = await resolveEntry(
          entry,
          srcDir,
          marketplace.pluginRoot,
          userId,
          warnings,
        );
        if (resolved) {
          resolvedDirs.push(resolved);
          if (resolved.cleanup) nestedCleanups.push(resolved.cleanup);
        }
      }
      if (resolvedDirs.length === 0) {
        throw new PluginInstallError(
          "None of the marketplace's plugins could be installed.",
        );
      }
    } else if (await looksLikePlugin(srcDir)) {
      resolvedDirs.push({ rootDir: srcDir, name: nameFromSource(source) });
    } else {
      throw new PluginInstallError(
        "No plugin found. Expected a .claude-plugin/marketplace.json, a .claude-plugin/plugin.json, a skills/ directory, or a SKILL.md at the repo root.",
      );
    }

    // Discover + copy each plugin into its own permanent install dir.
    const plugins: ResolvedPluginInstall[] = [];
    for (const rd of resolvedDirs) {
      const discovered = discoverPlugin(rd.rootDir, rd.name);
      if (discovered.skills.length === 0 && discovered.mcpServers.length === 0) {
        warnings.push(`Skipped "${rd.name}": no skills or MCP servers found.`);
        continue;
      }
      const id = nanoid();
      const installPath = pluginInstallDir(userId, id);
      await copyTree(rd.rootDir, installPath);
      plugins.push({
        id,
        name: discovered.name || rd.name,
        description: discovered.description ?? rd.description,
        version: discovered.version ?? rd.version,
        author: discovered.author,
        marketplace: marketplace?.name,
        installPath,
        skills: discovered.skills,
        mcpServers: discovered.mcpServers,
        warnings: discovered.warnings,
      });
    }

    if (plugins.length === 0) {
      throw new PluginInstallError(
        "Nothing to install — no skills or MCP servers were found.",
      );
    }

    return { plugins, warnings };
  } finally {
    for (const c of nestedCleanups) await rmrf(c);
  }
}
