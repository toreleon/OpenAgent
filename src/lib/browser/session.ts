import type { Browser, BrowserContext, Page } from "playwright";
import type { ToolIconKey } from "@/lib/toolActivity";
import type { BrowserActivity, StreamEvent } from "@/lib/types";

/**
 * Per-conversation headless-browser sessions for the browser-control tools.
 *
 * One shared Chromium process is launched lazily on first use and reused for the
 * whole server lifetime; each conversation gets its OWN isolated
 * {@link BrowserContext} (separate cookies/storage — no real user session is ever
 * exposed) plus a single {@link Page}. State is held on `globalThis` so it
 * survives Next.js dev HMR, exactly like the coding-sandbox workspace cache in
 * `src/lib/sandbox/confine.ts`.
 *
 * NOTE: this is the P0 walking-skeleton lifecycle — a shared browser + LRU-bounded
 * contexts. The idle-timeout reaper + connect-time SSRF guard-proxy are P2 (they
 * do NOT exist to clone from `confine.ts`, which only reaps child pids on
 * shutdown); the whole feature is gated off by default via BROWSER_CONTROL_ENABLED.
 */

/** A live per-turn browsing card, accumulated across the turn's browser_* calls. */
export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  /**
   * The browsing card for the CURRENT turn (a full {@link BrowserActivity}
   * snapshot that each tool call updates + re-emits). Reset when a new turn is
   * detected via a change in the `onEvent` closure identity ({@link activityOwner}).
   */
  activity: BrowserActivity | null;
  /** The `onEvent` function identity that owns {@link activity} (turn boundary). */
  activityOwner: unknown;
  lastUsed: number;
  /** Serializes actions on this session's Page (chained-promise mutex) so
   *  concurrent tool calls in one turn can't drive the same Page at once. */
  queue: Promise<unknown>;
}

type Emit = (event: StreamEvent) => void;

const g = globalThis as unknown as {
  __browserRoot?: { browser: Browser | null; launching: Promise<Browser> | null };
  __browserSessions?: Map<string, BrowserSession>;
  __browserReaper?: ReturnType<typeof setInterval>;
  /** Count of sessions mid-creation (before they land in the Map), so the reaper
   *  doesn't close the shared browser out from under an in-flight newContext(). */
  __browserCreating?: number;
};

function root(): { browser: Browser | null; launching: Promise<Browser> | null } {
  return (g.__browserRoot ??= { browser: null, launching: null });
}

const sessions: Map<string, BrowserSession> =
  g.__browserSessions ?? (g.__browserSessions = new Map());

/** Bound retained contexts so a long-lived server can't grow without limit. */
const MAX_SESSIONS = 8;

/** A conversation id becomes an isolation key; validate it defensively even
 *  though it comes from our own RunContext and never from the model. */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Close a context that hasn't been used in this long. */
const IDLE_TTL_MS = 5 * 60_000;
/** How often the reaper sweeps for idle contexts. */
const REAP_INTERVAL_MS = 60_000;

/**
 * Start (once) a background reaper that closes idle contexts — and the shared
 * browser once nothing is using it — so a stuck or abandoned page can't leak a
 * Chromium process. This is the net-new lifecycle management the design flagged:
 * `confine.ts` reaps child pids only on shutdown, not on idle, so there was
 * nothing to clone here.
 */
function ensureReaper(): void {
  if (g.__browserReaper) return;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastUsed > IDLE_TTL_MS) void closeBrowserSession(id);
    }
    const r = root();
    if (sessions.size === 0 && (g.__browserCreating ?? 0) === 0 && r.browser) {
      const b = r.browser;
      r.browser = null;
      void b.close().catch(() => {});
    }
  }, REAP_INTERVAL_MS);
  // Never keep the Node process alive just for the reaper.
  if (typeof timer.unref === "function") timer.unref();
  g.__browserReaper = timer;
}

/** Launch (once) or return the shared headless Chromium, relaunching if it died. */
async function getBrowser(): Promise<Browser> {
  const r = root();
  if (r.browser && r.browser.isConnected()) return r.browser;
  if (r.launching) return r.launching;
  r.launching = (async () => {
    // Dynamic import so `playwright` (a heavy, Node-only, externalized dep) never
    // loads unless the browser tools are actually exercised.
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      // --disable-dev-shm-usage avoids /dev/shm exhaustion on small containers
      // (harmless locally). No --no-sandbox: keep Chromium's own sandbox on.
      args: ["--disable-dev-shm-usage"],
    });
    r.browser = browser;
    r.launching = null;
    return browser;
  })();
  try {
    return await r.launching;
  } catch (err) {
    r.launching = null;
    throw err;
  }
}

/** Get (or create) the isolated browser session for a conversation. */
export async function getBrowserSession(
  conversationId: string,
): Promise<BrowserSession> {
  if (!ID_RE.test(conversationId)) {
    throw new Error("Invalid or missing browser session id.");
  }
  ensureReaper();
  const existing = sessions.get(conversationId);
  if (existing) {
    if (!existing.page.isClosed()) {
      existing.lastUsed = Date.now();
      // Re-insert so Map order tracks recency (real LRU for eviction below).
      sessions.delete(conversationId);
      sessions.set(conversationId, existing);
      return existing;
    }
    // The page died (crash/close): reclaim the orphaned context before replacing
    // it, so it doesn't leak a Chromium context.
    await closeBrowserSession(conversationId);
  }
  // Reserve a creating slot so the idle reaper can't close the shared browser
  // during the awaits below (the session isn't in the Map yet, so size is 0).
  g.__browserCreating = (g.__browserCreating ?? 0) + 1;
  try {
    const browser = await getBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    const session: BrowserSession = {
      context,
      page,
      activity: null,
      activityOwner: null,
      lastUsed: Date.now(),
      queue: Promise.resolve(),
    };
    // Evict the LEAST-recently-used other session when at capacity.
    if (sessions.size >= MAX_SESSIONS && !sessions.has(conversationId)) {
      evictLruExcept(conversationId);
    }
    sessions.set(conversationId, session);
    return session;
  } finally {
    g.__browserCreating = Math.max(0, (g.__browserCreating ?? 1) - 1);
  }
}

/** Close the session with the oldest `lastUsed`, skipping `exceptId`. */
function evictLruExcept(exceptId: string): void {
  let victim: string | undefined;
  let oldest = Infinity;
  for (const [id, s] of sessions) {
    if (id === exceptId) continue;
    if (s.lastUsed < oldest) {
      oldest = s.lastUsed;
      victim = id;
    }
  }
  if (victim !== undefined) void closeBrowserSession(victim);
}

/** Close + forget a conversation's browser context (page + cookies). */
export async function closeBrowserSession(conversationId: string): Promise<void> {
  const session = sessions.get(conversationId);
  sessions.delete(conversationId);
  if (session) {
    try {
      await session.context.close();
    } catch {
      /* already closed */
    }
  }
}

/** Close every session + the shared browser + stop the reaper (tests/shutdown). */
export async function disposeBrowsers(): Promise<void> {
  for (const id of [...sessions.keys()]) await closeBrowserSession(id);
  const r = root();
  if (r.browser) {
    const b = r.browser;
    r.browser = null;
    try {
      await b.close();
    } catch {
      /* already closed */
    }
  }
  if (g.__browserReaper) {
    clearInterval(g.__browserReaper);
    g.__browserReaper = undefined;
  }
}

// ---------------------------------------------------------------------------
// Live "Browser" panel accumulation (mirrors the run_subagents onEvent emit).
// ---------------------------------------------------------------------------

function freshActivity(): BrowserActivity {
  return {
    id: "browser-0",
    status: "running",
    steps: 0,
    trace: [],
    startedAt: Date.now(),
  };
}

/**
 * Begin one browsing action: (re)start the turn's card if this is a new turn
 * (detected by a changed `onEvent` identity), append a running trace step, bump
 * the step counter, and emit a full snapshot. The prior running step is closed
 * to `done` first (mirrors the subagent runner's `closeTrace`).
 */
export function beginAction(
  session: BrowserSession,
  onEvent: Emit | undefined,
  action: string,
  icon: ToolIconKey,
): void {
  if (!session.activity || session.activityOwner !== onEvent) {
    session.activity = freshActivity();
    session.activityOwner = onEvent;
  }
  const a = session.activity;
  const trace = a.trace ?? (a.trace = []);
  for (const s of trace) if (s.status === "running") s.status = "done";
  trace.push({ label: action, icon, status: "running" });
  a.steps = (a.steps ?? 0) + 1;
  a.action = action;
  a.status = "running";
  emit(session, onEvent);
}

/**
 * Finish the latest browsing action: flip its trace step to `done`/`failed` and
 * fold in fresh page metadata (url/title/screenshot/final action label), then
 * emit the updated full snapshot.
 */
export function finishAction(
  session: BrowserSession,
  onEvent: Emit | undefined,
  ok: boolean,
  patch?: {
    url?: string;
    title?: string;
    thumbnailDataUrl?: string;
    action?: string;
  },
): void {
  const a = session.activity;
  if (!a) return;
  const trace = a.trace;
  if (trace && trace.length) trace[trace.length - 1].status = ok ? "done" : "failed";
  // Stamp the completion time of THIS action (last-write-wins). The card's frozen
  // duration then reflects the last real browser action, not turn-end — so the
  // timer doesn't keep inflating through the post-browse answer-generation phase.
  a.endedAt = Date.now();
  if (patch?.url !== undefined) a.url = patch.url;
  if (patch?.title !== undefined) a.title = patch.title;
  if (patch?.thumbnailDataUrl !== undefined) a.thumbnailDataUrl = patch.thumbnailDataUrl;
  if (patch?.action !== undefined) a.action = patch.action;
  emit(session, onEvent);
}

/**
 * Serialize an action on one session's Page: chain it on the session's queue so
 * two concurrent browser tool calls in a single turn can't drive the same
 * Playwright Page at once (which would interleave navigations and corrupt the
 * trace). Actions run in call order regardless of each other's outcome.
 */
export function runExclusive<T>(
  session: BrowserSession,
  fn: () => Promise<T>,
): Promise<T> {
  const run = session.queue.then(fn, fn);
  // Keep the chain alive whether this action resolves or rejects.
  session.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Emit a deep-copied full snapshot so a later in-place mutation can't
 *  retroactively alter a snapshot already handed to the SSE stream / store. */
function emit(session: BrowserSession, onEvent: Emit | undefined): void {
  const a = session.activity;
  if (!onEvent || !a) return;
  try {
    onEvent({
      type: "browser_activity",
      activity: { ...a, trace: a.trace ? a.trace.map((s) => ({ ...s })) : undefined },
    });
  } catch {
    /* client stream closed — drop this progress update */
  }
}
