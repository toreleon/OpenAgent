import type { Locator, Page } from "playwright";

/**
 * Accessibility-tree grounding for the browser-control tools.
 *
 * We ground actions on Playwright's aria snapshot in "ai" mode, which tags every
 * interactive element with a stable `[ref=eN]` handle — the same mechanism the
 * Playwright MCP server uses. The model reads the tree, then acts by ref
 * (`browser_click({ ref: "e12" })`), which resolves through Playwright's
 * `aria-ref=` selector engine. This is deterministic and ~10-100x cheaper than a
 * pixel/screenshot loop; screenshots are diagnostic-only (streamed to the panel).
 */

export interface PageSnapshot {
  url: string;
  title: string;
  /** The ref-tagged accessibility tree, e.g. `- button "Sign in" [ref=e12]`. */
  tree: string;
}

/** `[ref=eN]` handles look like `e` followed by digits. */
const REF_RE = /^e\d+$/;

/** Capture a ref-tagged accessibility snapshot of the current page. */
export async function snapshotPage(page: Page): Promise<PageSnapshot> {
  const body = page.locator("body");
  // The `mode: "ai"` option (what emits `[ref=eN]`) is not in Playwright's public
  // option type, so cast the argument only — this keeps the normal method call so
  // `this` stays bound to the locator.
  const opts = { mode: "ai" } as unknown as Parameters<Locator["ariaSnapshot"]>[0];
  let tree: string;
  try {
    tree = await body.ariaSnapshot(opts);
  } catch {
    // The page may be mid-navigation — e.g. a browser_click that followed a link:
    // the old document detaches before the new one commits, so "body" momentarily
    // matches nothing and ariaSnapshot throws. Wait for the new document to load,
    // then retry once, so a navigating click isn't mis-reported as a failure.
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    tree = await body.ariaSnapshot(opts);
  }
  let title = "";
  try {
    title = await page.title();
  } catch {
    /* page may be mid-navigation */
  }
  return { url: page.url(), title, tree };
}

/**
 * Resolve a `[ref=eN]` handle (from the latest snapshot) back to a clickable
 * locator. Throws on a malformed ref; a STALE ref (the page changed since the
 * snapshot) surfaces later as a locator timeout, which the tool reports as a
 * clean error telling the model to re-snapshot.
 */
export function refLocator(page: Page, ref: string): Locator {
  if (!REF_RE.test(ref)) {
    throw new Error(`Invalid ref "${ref}". Expected a snapshot ref like "e12".`);
  }
  return page.locator(`aria-ref=${ref}`);
}
