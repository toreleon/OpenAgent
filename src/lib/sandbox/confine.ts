import fs from "fs";
import fsp from "fs/promises";
import path from "path";

/**
 * The local coding sandbox. Every file/shell tool routes its model-supplied
 * paths through {@link resolveInside} before touching disk, so a model can only
 * read/write inside a per-conversation workspace and can never escape it via
 * `..`, an absolute path, or a symlink.
 *
 * Because this is a single-user local dev box with no Docker, path confinement
 * (for file ops) plus a scrubbed env + timeouts + output caps (for run_shell)
 * ARE the isolation. There is no container boundary. run_shell is the highest-
 * risk tool: its cwd is the workspace, but a shell can still `cd` out or read an
 * absolute path — the real protections are the scrubbed env (no secrets reach a
 * child), a hard timeout, an output cap, and killing the whole process group.
 */

export type SandboxErrorCode =
  | "bad_path"
  | "absolute_path"
  | "path_escape"
  | "protected_path"
  | "no_workspace";

/** Thrown by {@link resolveInside} on a confinement violation. Mirrors the
 *  SafeFetchError shape in src/lib/net/safe-fetch.ts so tools can uniformly turn
 *  it into an `{ ok:false, code, error }` result. */
export class SandboxError extends Error {
  code: SandboxErrorCode;
  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
  }
}

const WORKSPACES_DIRNAME = ".workspaces";
/** The confined working tree. Kept as a subdir so sibling state (.home) can live
 *  OUTSIDE the model-visible root. */
const REPO_SUBDIR = "repo";
/** A workspace-local HOME for run_shell so child processes never read the real
 *  user's ~/.ssh, ~/.aws, ~/.npmrc, etc. */
const HOME_SUBDIR = ".home";

/** Per-conversation sandbox state. Held on globalThis so it survives Next.js dev
 *  HMR (module reloads), mirroring how the scheduler runner keeps its state. */
interface WorkspaceState {
  /** realpath()'d canonical workspace root (.workspaces/<id>/repo). */
  realRoot: string;
  /** Workspace-local HOME dir handed to run_shell. */
  home: string;
  /** absPath -> mtimeMs recorded at read time; powers edit_file's read-before-
   *  edit + stale-detection gate. */
  reads: Map<string, number>;
  /** Live child process-group leader pids, for reaping on shutdown. */
  bgPids: Set<number>;
  /** Serializes write ops per conversation so concurrent tool calls can't
   *  interleave a read-then-write on the same file. */
  writeChain: Promise<unknown>;
}

const g = globalThis as unknown as {
  __sandboxStates?: Map<string, WorkspaceState>;
};
const states: Map<string, WorkspaceState> =
  g.__sandboxStates ?? (g.__sandboxStates = new Map());

/** Bound retained state so a long-lived server can't grow memory without limit.
 *  The Map preserves insertion order, so the first key is the oldest. */
const MAX_WORKSPACES = 200;
/** Bound the per-workspace read-set so a conversation that reads thousands of
 *  files can't grow one Map without limit. */
const MAX_READS_PER_WORKSPACE = 5_000;

/** A conversation id is a cuid-like token that becomes a path segment. Validate
 *  it defensively — it should never contain a separator or traversal, even
 *  though it comes from our own RunContext and not the model. */
function assertSafeId(conversationId: string): void {
  if (!conversationId || !/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) {
    throw new SandboxError("no_workspace", "Invalid or missing workspace id.");
  }
}

/**
 * Resolve (creating on first use) and cache the canonical workspace root for a
 * conversation. The repo dir is realpath()'d exactly ONCE and cached, because on
 * macOS `/var` is a symlink to `/private/var` (and `.workspaces` may itself be
 * symlinked); without pre-canonicalizing the root, the prefix check below would
 * reject legitimate paths.
 */
export function getWorkspace(conversationId: string): {
  realRoot: string;
  home: string;
} {
  assertSafeId(conversationId);
  const existing = states.get(conversationId);
  if (existing) return { realRoot: existing.realRoot, home: existing.home };

  const base = path.join(process.cwd(), WORKSPACES_DIRNAME, conversationId);
  const repo = path.join(base, REPO_SUBDIR);
  const home = path.join(base, HOME_SUBDIR);
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const realRoot = fs.realpathSync(repo);

  // Evict the oldest workspace state when at capacity (in-memory bookkeeping
  // only — the on-disk workspace is untouched and re-hydrates on next use).
  if (states.size >= MAX_WORKSPACES) {
    const oldest = states.keys().next().value;
    if (oldest !== undefined) states.delete(oldest);
  }

  states.set(conversationId, {
    realRoot,
    home,
    reads: new Map(),
    bgPids: new Set(),
    writeChain: Promise.resolve(),
  });
  return { realRoot, home };
}

function getState(conversationId: string): WorkspaceState {
  getWorkspace(conversationId); // ensure created + cached
  return states.get(conversationId)!;
}

/**
 * Walk up from a not-yet-existing absolute path to its nearest existing
 * ancestor, realpath() that ancestor, then re-join the missing tail. This lets
 * us confine writes/creates whose final segments don't exist yet while still
 * defeating a symlinked ancestor directory.
 */
function confineNonExistent(abs: string): string {
  const tail: string[] = [];
  let cur = abs;
  while (true) {
    const parent = path.dirname(cur);
    if (parent === cur) return abs; // reached fs root without an existing ancestor
    tail.push(path.basename(cur));
    cur = parent;
    try {
      const realCur = fs.realpathSync(cur);
      return path.join(realCur, ...tail.reverse());
    } catch {
      // ancestor still missing — keep walking up
    }
  }
}

export interface ResolveOpts {
  /** True for write/create ops: the target may not exist yet, and protected
   *  segments (.git, node_modules) are denied. */
  forWrite: boolean;
}

/**
 * Resolve a model-supplied RELATIVE path to a confined absolute path inside the
 * conversation's workspace, or throw {@link SandboxError}. The single
 * load-bearing gate every file tool (and run_shell's workdir) routes through.
 *
 * Algorithm: reject NUL → reject absolute → path.resolve() against realRoot →
 * canonicalize with realpath (the target itself if it exists — which follows a
 * final symlink — else the nearest existing ancestor + tail) → assert the
 * canonical path === realRoot OR starts with `realRoot + path.sep`. The trailing
 * separator is load-bearing: without it a sibling like `<root>-evil` would slip
 * past a bare `startsWith(root)` check.
 */
export function resolveInside(
  conversationId: string,
  relPath: string,
  opts: ResolveOpts,
): string {
  const { realRoot } = getWorkspace(conversationId);

  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new SandboxError(
      "bad_path",
      "Path must be a non-empty string relative to the workspace root.",
    );
  }
  if (relPath.includes("\0")) {
    throw new SandboxError("bad_path", "Path contains a NUL byte.");
  }
  if (path.isAbsolute(relPath)) {
    throw new SandboxError(
      "absolute_path",
      "Absolute paths are not allowed; use a path relative to the workspace root.",
    );
  }

  const abs = path.resolve(realRoot, relPath);

  let canonical: string;
  try {
    // Exists (file/dir/symlink) → fully canonical, following a final symlink so
    // a link inside the repo pointing OUT is caught here.
    canonical = fs.realpathSync(abs);
  } catch {
    // Doesn't exist yet → canonicalize the nearest existing ancestor + tail.
    canonical = confineNonExistent(abs);
  }

  if (canonical !== realRoot && !canonical.startsWith(realRoot + path.sep)) {
    throw new SandboxError(
      "path_escape",
      `Path escapes the workspace root: ${relPath}`,
    );
  }

  // Defense against a symlinked FINAL component. The realpathSync(abs) above only
  // catches a symlink whose target EXISTS (it resolves outside → rejected). A
  // DANGLING symlink (target missing) makes realpathSync throw, so control fell
  // to confineNonExistent, which realpaths only the nearest existing ANCESTOR
  // and never inspects the leaf — so the leaf being a symlink is invisible.
  // Without this check a subsequent writeFile would FOLLOW such a link and create
  // a file OUTSIDE the workspace (a full escape). If the leaf is a symlink,
  // require its resolved target to be inside the root; a dangling link can't
  // resolve and is rejected outright.
  const leaf = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (leaf?.isSymbolicLink()) {
    let target: string;
    try {
      target = fs.realpathSync(abs);
    } catch {
      throw new SandboxError(
        "path_escape",
        `Refusing to follow a symlink out of the workspace: ${relPath}`,
      );
    }
    if (target !== realRoot && !target.startsWith(realRoot + path.sep)) {
      throw new SandboxError(
        "path_escape",
        `Symlink target escapes the workspace root: ${relPath}`,
      );
    }
  }

  if (opts.forWrite) {
    // Case-fold segments: on case-insensitive filesystems (default macOS APFS,
    // NTFS) ".GIT" / "Node_Modules" address the same protected dirs as ".git" /
    // "node_modules", so a bare case-sensitive compare would be bypassable.
    const segs = path
      .relative(realRoot, abs)
      .split(path.sep)
      .map((s) => s.toLowerCase());
    if (segs.includes(".git") || segs.includes("node_modules")) {
      throw new SandboxError(
        "protected_path",
        "Refusing to write inside .git/ or node_modules/. Use run_shell (git, npm) for those.",
      );
    }
  }

  return abs;
}

// ---------------------------------------------------------------------------
// Read-set (read-before-edit gate)
// ---------------------------------------------------------------------------

/** Record that `absPath` was read at on-disk mtime `mtimeMs`. */
export function recordRead(
  conversationId: string,
  absPath: string,
  mtimeMs: number,
): void {
  const reads = getState(conversationId).reads;
  // Bound the read-set: drop the oldest entry when over capacity. Re-reading a
  // file re-adds it, so an active edit target is unlikely to be the one evicted.
  if (!reads.has(absPath) && reads.size >= MAX_READS_PER_WORKSPACE) {
    const oldest = reads.keys().next().value;
    if (oldest !== undefined) reads.delete(oldest);
  }
  reads.set(absPath, mtimeMs);
}

let tmpCounter = 0;

/**
 * Write `content` to `abs` atomically: write a temp file in the same directory,
 * then rename it over the target (rename is atomic on one filesystem, so a crash
 * mid-write can't leave a half-written file, and a concurrent reader never sees a
 * truncated file). rename also REPLACES a symlink at the destination rather than
 * following it. The temp file is unlinked on any failure. `abs` must already be
 * confined via {@link resolveInside}.
 */
export async function atomicWrite(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.sandbox-tmp-${process.pid}-${tmpCounter++}`;
  try {
    await fsp.writeFile(tmp, content, "utf8");
    await fsp.rename(tmp, abs);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** The mtime recorded when `absPath` was last read this conversation, or
 *  undefined if it was never read. */
export function getRecordedRead(
  conversationId: string,
  absPath: string,
): number | undefined {
  return getState(conversationId).reads.get(absPath);
}

/** Whether `absPath` has been read this conversation. */
export function hasRead(conversationId: string, absPath: string): boolean {
  return getState(conversationId).reads.has(absPath);
}

// ---------------------------------------------------------------------------
// Write serialization + process reaping
// ---------------------------------------------------------------------------

/**
 * Run an async op serialized against the conversation's write chain, so two
 * concurrent tool calls can't interleave a read-then-write on the same file. An
 * error in one op never poisons the chain for the next.
 */
export function withWriteLock<T>(
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const st = getState(conversationId);
  const result = st.writeChain.then(fn, fn);
  st.writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function trackPid(conversationId: string, pid: number): void {
  getState(conversationId).bgPids.add(pid);
}
export function untrackPid(conversationId: string, pid: number): void {
  getState(conversationId).bgPids.delete(pid);
}

// ---------------------------------------------------------------------------
// RunContext helpers + shared tool-result shapes
// ---------------------------------------------------------------------------

/** Extract the workspace conversationId threaded via the Agents SDK RunContext
 *  (run(agent, input, { context: { conversationId } })). Returns undefined when
 *  absent so tools can fail gracefully instead of throwing. */
export function conversationIdFromContext(ctx: unknown): string | undefined {
  const c = (ctx as { context?: { conversationId?: unknown } } | undefined)
    ?.context;
  const id = c?.conversationId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Extract the owning userId threaded via the same RunContext
 *  (run(agent, input, { context: { conversationId, userId } })). Used by the
 *  `skill` tool to load the calling user's installed skills. Returns undefined
 *  when absent so the tool can fail gracefully. */
export function userIdFromContext(ctx: unknown): string | undefined {
  const c = (ctx as { context?: { userId?: unknown } } | undefined)?.context;
  const id = c?.userId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Uniform "no workspace bound" result for when RunContext lacks a
 *  conversationId (e.g. a tool somehow invoked outside a chat run). */
export function noWorkspaceResult() {
  return {
    ok: false as const,
    code: "no_workspace" as const,
    error:
      "No workspace is bound to this run, so file/shell tools are unavailable.",
  };
}

/** Turn any thrown error into the uniform `{ ok:false, code, error }` shape.
 *  Tools must NEVER throw out of execute() — a throw would break the SSE stream
 *  and the tool card. */
export function toToolError(err: unknown) {
  if (err instanceof SandboxError) {
    return { ok: false as const, code: err.code, error: err.message };
  }
  return {
    ok: false as const,
    code: "error" as const,
    error: err instanceof Error ? err.message : String(err),
  };
}
