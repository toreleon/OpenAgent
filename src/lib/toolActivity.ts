/**
 * Friendly presentation of tool activity.
 *
 * A tool call is NEVER shown to the user as its raw internal name or JSON args.
 * Instead we render a compact activity row: an icon + a human verb + at most one
 * summarized argument (a search query, a hostname, a file basename). This module
 * holds the pure derivation logic so the client store (building the live
 * timeline), the server route (persisting it), and the `ActivityRow` component
 * (rendering it) all agree — no React here.
 */

/** Coarse icon identifier resolved to a concrete lucide icon in ActivityRow. */
export type ToolIconKey =
  | "web"
  | "page"
  | "code"
  | "terminal"
  | "file"
  | "edit"
  | "new-file"
  | "folder"
  | "search"
  | "clock"
  | "skill"
  | "tool";

/** Read a string field off an unknown args object, tolerating any shape. */
function argStr(args: unknown, key: string): string | undefined {
  if (args && typeof args === "object" && key in args) {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/** The last path segment (basename) of a slash-separated path. */
function basename(p: string): string {
  const cleaned = p.replace(/[/\\]+$/, "");
  const seg = cleaned.split(/[/\\]/).pop();
  return seg && seg.length ? seg : cleaned || p;
}

/** Compact hostname for a URL (drops the leading www.). Falls back to the raw string. */
function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Truncate a value to `max` chars with an ellipsis, collapsing whitespace. */
function truncate(s: string, max = 42): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + "…" : one;
}

/**
 * Extract the ONE summarized argument shown next to a tool's verb. Returns a
 * short display string (never the full args) or undefined when the tool reads
 * better with no argument (e.g. "Ran code").
 */
export function extractToolArg(tool: string, args: unknown): string | undefined {
  switch (tool) {
    case "web_search":
      return truncate(argStr(args, "query") ?? "", 48) || undefined;
    case "web_fetch": {
      const url = argStr(args, "url");
      return url ? hostname(url) : undefined;
    }
    case "grep_search":
      return truncate(argStr(args, "pattern") ?? "", 48) || undefined;
    case "run_shell":
      return truncate(argStr(args, "command") ?? "", 48) || undefined;
    case "read_file":
    case "edit_file":
    case "write_file": {
      const p = argStr(args, "path");
      return p ? basename(p) : undefined;
    }
    case "list_dir": {
      const p = argStr(args, "path");
      return p && p !== "." ? basename(p) : undefined;
    }
    case "skill":
      return truncate(argStr(args, "name") ?? "", 48) || undefined;
    case "run_javascript":
    case "get_current_time":
      return undefined;
    default: {
      // Unknown / MCP tool: prefer a query/path/url-ish field if present.
      const guess =
        argStr(args, "query") ??
        argStr(args, "path") ??
        argStr(args, "url") ??
        argStr(args, "name");
      return guess ? truncate(guess, 48) : undefined;
    }
  }
}

/** Humanize an unknown tool name: "some_tool_name" -> "some tool name". */
function humanizeToolName(tool: string): string {
  return tool.replace(/[_-]+/g, " ").trim() || "tool";
}

/**
 * The friendly label for a tool row, tensed by status: present continuous while
 * running ("Searching the web"), simple past once done ("Searched the web"), and
 * a quiet failure phrasing on error ("Couldn't search the web").
 */
export function toolActivityLabel(
  tool: string,
  arg: string | undefined,
  status: "running" | "done" | "error",
): string {
  // Each tool maps to [running, done, failed] verb templates. `{arg}` is
  // interpolated only when an argument is present; a paren'd suffix is dropped
  // when there is no arg so labels never read "Searched for ''".
  const q = arg ? `“${arg}”` : "";
  type Verbs = { run: string; done: string; fail: string };
  const withArg = (v: Verbs, plain: Verbs): Verbs => (arg ? v : plain);

  let verbs: Verbs;
  switch (tool) {
    case "web_search":
      verbs = withArg(
        { run: `Searching the web for ${q}`, done: `Searched the web for ${q}`, fail: `Couldn't search the web for ${q}` },
        { run: "Searching the web", done: "Searched the web", fail: "Couldn't search the web" },
      );
      break;
    case "web_fetch":
      verbs = withArg(
        { run: `Reading ${arg}`, done: `Read ${arg}`, fail: `Couldn't read ${arg}` },
        { run: "Reading page", done: "Read page", fail: "Couldn't read page" },
      );
      break;
    case "run_javascript":
      verbs = { run: "Running code", done: "Ran code", fail: "Code run failed" };
      break;
    case "run_shell":
      verbs = withArg(
        { run: `Running ${q}`, done: `Ran ${q}`, fail: `Command failed: ${q}` },
        { run: "Running a command", done: "Ran a command", fail: "Command failed" },
      );
      break;
    case "read_file":
      verbs = withArg(
        { run: `Reading ${arg}`, done: `Read ${arg}`, fail: `Couldn't read ${arg}` },
        { run: "Reading a file", done: "Read a file", fail: "Couldn't read the file" },
      );
      break;
    case "edit_file":
      verbs = withArg(
        { run: `Editing ${arg}`, done: `Edited ${arg}`, fail: `Couldn't edit ${arg}` },
        { run: "Editing a file", done: "Edited a file", fail: "Couldn't edit the file" },
      );
      break;
    case "write_file":
      verbs = withArg(
        { run: `Creating ${arg}`, done: `Created ${arg}`, fail: `Couldn't create ${arg}` },
        { run: "Creating a file", done: "Created a file", fail: "Couldn't create the file" },
      );
      break;
    case "list_dir":
      verbs = withArg(
        { run: `Listing ${arg}`, done: `Listed ${arg}`, fail: `Couldn't list ${arg}` },
        { run: "Listing the workspace", done: "Listed the workspace", fail: "Couldn't list the workspace" },
      );
      break;
    case "grep_search":
      verbs = withArg(
        { run: `Searching for ${q}`, done: `Searched for ${q}`, fail: `Couldn't search for ${q}` },
        { run: "Searching files", done: "Searched files", fail: "Couldn't search files" },
      );
      break;
    case "get_current_time":
      verbs = { run: "Checking the time", done: "Checked the time", fail: "Couldn't check the time" };
      break;
    case "skill":
      verbs = withArg(
        { run: `Using the ${arg} skill`, done: `Used the ${arg} skill`, fail: `Couldn't load the ${arg} skill` },
        { run: "Using a skill", done: "Used a skill", fail: "Couldn't load the skill" },
      );
      break;
    default: {
      const name = humanizeToolName(tool);
      verbs = withArg(
        { run: `Using ${name} (${arg})`, done: `Used ${name} (${arg})`, fail: `${name} failed` },
        { run: `Using ${name}`, done: `Used ${name}`, fail: `${name} failed` },
      );
    }
  }

  return status === "running" ? verbs.run : status === "error" ? verbs.fail : verbs.done;
}

/** The icon key for a tool row. */
export function toolActivityIcon(tool: string): ToolIconKey {
  switch (tool) {
    case "web_search":
      return "web";
    case "web_fetch":
      return "page";
    case "run_javascript":
      return "code";
    case "run_shell":
      return "terminal";
    case "read_file":
      return "file";
    case "edit_file":
      return "edit";
    case "write_file":
      return "new-file";
    case "list_dir":
      return "folder";
    case "grep_search":
      return "search";
    case "get_current_time":
      return "clock";
    case "skill":
      return "skill";
    default:
      return "tool";
  }
}
