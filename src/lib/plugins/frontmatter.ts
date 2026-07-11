/**
 * A tiny, dependency-free parser for the YAML frontmatter at the top of a
 * SKILL.md. We only need the top-level scalar fields (`name`, `description`,
 * `license`) plus the markdown body — NOT a full YAML engine. It handles the
 * cases real SKILL.md files use: quoted scalars, and `>`/`|` block scalars for
 * multi-line descriptions. Nested maps (e.g. `metadata:`) are skipped rather
 * than mis-parsed. Anything it can't understand degrades to an empty map, never
 * a throw — a malformed skill should be skipped, not crash discovery.
 */

export interface ParsedFrontmatter {
  /** Top-level scalar fields, keys lowercased-as-written (casing preserved). */
  data: Record<string, string>;
  /** The markdown body after the closing `---` fence (or the whole file if no
   *  frontmatter). */
  body: string;
}

/** Leading-space count of a line (tabs count as one). */
function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " " || ch === "\t") n++;
    else break;
  }
  return n;
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const content = raw.replace(/\r\n/g, "\n").replace(/^﻿/, "");

  // Frontmatter must be the very first thing: a `---` line, then keys, then a
  // closing `---` (or `...`) line.
  const m = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n([\s\S]*))?$/.exec(
    content,
  );
  if (!m) {
    return { data: {}, body: content };
  }

  const fmText = m[1];
  const body = (m[2] ?? "").replace(/^\n+/, "");
  const lines = fmText.split("\n");
  const data: Record<string, string> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    // Only parse TOP-LEVEL keys (indent 0). Indented lines belong to a block
    // scalar or a nested map handled/skipped below.
    if (indentOf(line) !== 0) continue;

    const km = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!km) continue;
    const key = km[1];
    const rest = km[2];

    // Block scalar: `>` (folded) or `|` (literal), with optional chomp/indent.
    if (/^[|>][+-]?[0-9]*\s*$/.test(rest)) {
      const folded = rest.trimStart()[0] === ">";
      const collected: string[] = [];
      let j = i + 1;
      // Determine the block's indent from the first non-blank child line.
      let blockIndent = -1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === "") {
          collected.push("");
          continue;
        }
        const ind = indentOf(l);
        if (blockIndent === -1) {
          if (ind === 0) break; // no indented body → empty block
          blockIndent = ind;
        }
        if (ind < blockIndent) break;
        collected.push(l.slice(blockIndent));
      }
      i = j - 1;
      // Trim trailing blank lines, then fold/join.
      while (collected.length && collected[collected.length - 1] === "") {
        collected.pop();
      }
      data[key] = folded
        ? collected.join(" ").replace(/\s+/g, " ").trim()
        : collected.join("\n");
      continue;
    }

    // Nested map (e.g. `metadata:` with nothing after the colon) — skip its
    // indented children; we don't need them.
    if (rest === "") {
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim() === "") continue;
        if (indentOf(lines[j]) === 0) break;
      }
      i = j - 1;
      continue;
    }

    // Inline scalar. A quoted value ends at its matching closing quote; anything
    // after it (e.g. ` # comment`) is discarded. An unquoted value is truncated
    // at the first ` #` comment and trimmed.
    const q = rest[0];
    let value: string;
    if (q === '"' || q === "'") {
      const close = rest.indexOf(q, 1);
      value = close === -1 ? rest.slice(1) : rest.slice(1, close);
    } else {
      const hash = rest.indexOf(" #");
      value = (hash === -1 ? rest : rest.slice(0, hash)).trim();
    }
    data[key] = value;
  }

  return { data, body };
}
