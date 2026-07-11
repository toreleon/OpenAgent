import fs from "fs";
import path from "path";

/**
 * On-disk layout + a read-only path jail for installed plugins.
 *
 * Plugins are cloned/copied under `.plugins/<userId>/<pluginId>/` (a sibling of
 * the coding sandbox's `.workspaces/`, and OUTSIDE any model-visible workspace).
 * The agent never writes here — it only reads a skill's SKILL.md body and its
 * bundled resource files through the `skill` tool. Every model/user-supplied
 * relative path is routed through {@link resolveWithin} first, so a skill file
 * reference can never escape its plugin's install dir via `..`, an absolute
 * path, or a symlink (the same defense confine.ts applies to the sandbox).
 */

const PLUGINS_DIRNAME = ".plugins";

/** A DB id (cuid) that becomes a path segment. Validate defensively even though
 *  it comes from our own DB and not the model. */
function assertSafeSegment(seg: string, label: string): void {
  if (!seg || !/^[A-Za-z0-9_-]{1,128}$/.test(seg)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(seg)}`);
  }
}

/** Absolute path of the plugins root (`<cwd>/.plugins`). */
export function pluginsRoot(): string {
  return path.join(process.cwd(), PLUGINS_DIRNAME);
}

/** Absolute install dir for one plugin: `.plugins/<userId>/<pluginId>`. */
export function pluginInstallDir(userId: string, pluginId: string): string {
  assertSafeSegment(userId, "userId");
  assertSafeSegment(pluginId, "pluginId");
  return path.join(pluginsRoot(), userId, pluginId);
}

/** A scratch dir used while fetching/parsing a source before its plugins are
 *  copied to their final per-plugin install dirs. Removed by the installer. */
export function pluginTmpDir(userId: string, token: string): string {
  assertSafeSegment(userId, "userId");
  assertSafeSegment(token, "token");
  return path.join(pluginsRoot(), userId, `.tmp-${token}`);
}

/**
 * Walk up from a not-yet-existing absolute path to its nearest existing
 * ancestor, realpath() that ancestor, then re-join the missing tail. Mirrors
 * confine.ts#confineNonExistent so a symlinked ANCESTOR directory can't be used
 * to escape.
 */
function confineNonExistent(abs: string): string {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    tail.push(path.basename(cur));
    cur = parent;
    try {
      const realCur = fs.realpathSync(cur);
      return path.join(realCur, ...tail.reverse());
    } catch {
      // keep walking up
    }
  }
}

/**
 * Resolve a RELATIVE path to a confined absolute path inside `realRoot`, or
 * throw. `realRoot` MUST already be canonical (realpath'd) by the caller. The
 * single read gate the `skill` tool routes bundled-file reads through.
 *
 * Algorithm mirrors confine.ts#resolveInside (read-only variant): reject NUL /
 * absolute → resolve against realRoot → canonicalize (target if it exists, else
 * nearest existing ancestor + tail) → assert the result is realRoot or under
 * `realRoot + sep` → reject a symlink leaf whose target escapes.
 */
export function resolveWithin(realRoot: string, relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("Path must be a non-empty string relative to the skill root.");
  }
  if (relPath.includes("\0")) {
    throw new Error("Path contains a NUL byte.");
  }
  if (path.isAbsolute(relPath)) {
    throw new Error("Absolute paths are not allowed; use a path relative to the skill root.");
  }

  const abs = path.resolve(realRoot, relPath);

  let canonical: string;
  try {
    canonical = fs.realpathSync(abs);
  } catch {
    canonical = confineNonExistent(abs);
  }

  if (canonical !== realRoot && !canonical.startsWith(realRoot + path.sep)) {
    throw new Error(`Path escapes the skill root: ${relPath}`);
  }

  const leaf = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (leaf?.isSymbolicLink()) {
    let target: string;
    try {
      target = fs.realpathSync(abs);
    } catch {
      throw new Error(`Refusing to follow a symlink out of the skill root: ${relPath}`);
    }
    if (target !== realRoot && !target.startsWith(realRoot + path.sep)) {
      throw new Error(`Symlink target escapes the skill root: ${relPath}`);
    }
  }

  return abs;
}
