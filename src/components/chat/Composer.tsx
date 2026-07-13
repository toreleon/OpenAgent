"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowUp, FileText, Sparkles, Square, X } from "lucide-react";
import type { Attachment, ComposerProps, SkillListItem } from "@/lib/types";
import FileUpload from "@/components/upload/FileUpload";
import { ModelEffortPicker } from "./ModelEffortPicker";
import { cn } from "@/components/ui/cn";

const MAX_TEXTAREA_HEIGHT = 200;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ComposerFullProps extends ComposerProps {
  model: string;
  onModelChange: (modelId: string) => void;
  /** Optional externally-provided initial text (e.g. from a suggestion card). */
  draft?: string;
  onDraftConsumed?: () => void;
  /** Hide the "OpenAgent can make mistakes" line (e.g. on the project home). */
  hideDisclaimer?: boolean;
}

/** Bottom input bar with auto-growing textarea + attachments. */
export function Composer({
  onSend,
  isStreaming,
  onStop,
  disabled,
  placeholder = "Message OpenAgent",
  model,
  onModelChange,
  draft,
  onDraftConsumed,
  hideDisclaimer,
}: ComposerFullProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ---- Slash-command menu -------------------------------------------------
  // Typing "/" at the very start of the message opens an autocomplete of the
  // app's built-in commands (Deep Research) plus the user's installed skills;
  // picking one inserts "/<name> " so the rest of the line becomes its input.
  // The server routes the command (see /api/chat: matchBuiltinCommand /
  // resolveSlashSkill).
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // True once we've fetched the menu list for the CURRENT slash session; reset
  // when the message stops being a slash command, so each new "/" refetches and
  // picks up plugins installed/removed in Settings without a page reload.
  const skillFetchSessionRef = useRef(false);

  // The message is a slash command "in progress" iff it's a leading /token with
  // no space yet.
  const slashQuery = useMemo(() => {
    const m = /^\/([A-Za-z0-9_-]*)$/.exec(value);
    return m ? m[1].toLowerCase() : null;
  }, [value]);

  const filteredSkills = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery;
    const scored = skills
      .map((s) => {
        const name = s.name.toLowerCase();
        const rank = name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2;
        return { s, rank };
      })
      .filter((x) => q === "" || x.rank < 2)
      .sort((a, b) => a.rank - b.rank || a.s.name.localeCompare(b.s.name));
    return scored.map((x) => x.s).slice(0, 8);
  }, [skills, slashQuery]);

  const menuOpen = slashQuery !== null && !menuDismissed && filteredSkills.length > 0;

  // Fetch the skill list once per slash session (when the message first becomes
  // a "/command"), refetching on each new session so the menu stays fresh.
  useEffect(() => {
    if (slashQuery === null) {
      skillFetchSessionRef.current = false;
      return;
    }
    if (skillFetchSessionRef.current) return;
    skillFetchSessionRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/skills", { cache: "no-store" });
        if (res.ok && !cancelled) {
          setSkills((await res.json()) as SkillListItem[]);
        }
      } catch {
        /* ignore — no menu */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slashQuery]);

  // Reset the highlighted row whenever the query changes; clear the Escape
  // dismissal once the message is no longer a slash command.
  useEffect(() => setMenuIndex(0), [slashQuery]);
  useEffect(() => {
    if (slashQuery === null && menuDismissed) setMenuDismissed(false);
  }, [slashQuery, menuDismissed]);

  function selectSkill(skill: SkillListItem) {
    setValue(`/${skill.name} `);
    setMenuDismissed(false);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }

  // Adopt an external draft (suggestion card click).
  useEffect(() => {
    if (draft) {
      setValue(draft);
      onDraftConsumed?.();
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // Auto-grow the textarea.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 && !isStreaming && !disabled;

  function submit() {
    if (!canSend) return;
    onSend(value.trim(), attachments);
    setValue("");
    setAttachments([]);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.style.height = "auto";
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // When the slash-skill menu is open, its keys take priority over the
    // textarea (arrow to move, Enter/Tab to pick, Escape to dismiss). Skip while
    // an IME composition is active so confirming a candidate commits text
    // instead of picking a skill.
    if (menuOpen && !e.nativeEvent.isComposing) {
      const len = filteredSkills.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % len);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + len) % len);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectSkill(filteredSkills[Math.min(menuIndex, len - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  return (
    <div className="w-full px-4 pb-4">
      <div className="relative mx-auto w-full max-w-chat">
        {menuOpen && (
          <SkillMenu
            skills={filteredSkills}
            activeIndex={Math.min(menuIndex, filteredSkills.length - 1)}
            onHover={setMenuIndex}
            onSelect={selectSkill}
          />
        )}
        <div
          className={cn(
            "flex flex-col rounded-3xl border border-border bg-composer shadow-lg transition-colors",
            disabled && "opacity-60",
          )}
        >
          {/* Attachment preview row */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((a) =>
                a.kind === "image" ? (
                  <div key={a.id} className="group relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={a.url}
                      alt={a.name}
                      className="h-16 w-16 rounded-xl border border-border object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.id)}
                      aria-label={`Remove ${a.name}`}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black text-white opacity-90 transition-opacity hover:opacity-100"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <div
                    key={a.id}
                    className="group relative flex items-center gap-2 rounded-xl border border-border bg-user-bubble px-3 py-2 pr-7"
                  >
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/20 text-accent">
                      <FileText size={16} />
                    </span>
                    <span className="flex flex-col">
                      <span className="max-w-[10rem] truncate text-xs font-medium text-text-primary">
                        {a.name}
                      </span>
                      <span className="text-[11px] text-text-secondary">
                        {formatBytes(a.size)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.id)}
                      aria-label={`Remove ${a.name}`}
                      className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black text-white opacity-80 transition-opacity hover:opacity-100"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ),
              )}
            </div>
          )}

          {/* Textarea */}
          <div className="flex items-end gap-2 px-2.5 py-2">
            <FileUpload
              onUploaded={(a: Attachment[]) =>
                setAttachments((prev) => [...prev, ...a])
              }
              disabled={isStreaming || disabled}
            />

            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              disabled={disabled}
              placeholder={placeholder}
              className="max-h-[200px] flex-1 resize-none bg-transparent py-2 text-text-primary placeholder:text-text-secondary focus:outline-none disabled:cursor-not-allowed"
            />

            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop generating"
                className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-text-primary text-main transition-opacity hover:opacity-90"
              >
                <Square size={16} className="fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                aria-label="Send message"
                className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-text-primary text-main transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-text-primary/30 disabled:text-main/60"
              >
                <ArrowUp size={18} strokeWidth={2.5} />
              </button>
            )}
          </div>

          {/* Footer row: Claude-style merged model + effort control */}
          <div className="flex items-center justify-end px-2.5 pb-1.5">
            <ModelEffortPicker
              value={model}
              onChange={onModelChange}
              disabled={isStreaming}
              side="top"
              align="end"
            />
          </div>
        </div>

        {!hideDisclaimer && (
          <p className="mt-2 text-center text-xs text-text-secondary">
            OpenAgent can make mistakes. Check important info.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The `/` slash-command autocomplete: a popover above the composer listing the
 * user's installed skills. Rendered only while a leading `/query` matches at
 * least one skill; keyboard nav lives in the composer's onKeyDown so Enter/Tab
 * pick a skill instead of sending.
 */
function SkillMenu({
  skills,
  activeIndex,
  onHover,
  onSelect,
}: {
  skills: SkillListItem[];
  activeIndex: number;
  onHover: (i: number) => void;
  onSelect: (s: SkillListItem) => void;
}) {
  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-2xl border border-border bg-composer shadow-xl">
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
        <Sparkles size={12} /> Skills
      </div>
      <ul className="max-h-64 overflow-y-auto py-1">
        {skills.map((s, i) => (
          <li key={`${s.plugin}/${s.name}`}>
            <button
              type="button"
              // Use onMouseDown (not onClick) so the textarea doesn't blur
              // before the selection runs.
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(s);
              }}
              onMouseEnter={() => onHover(i)}
              className={cn(
                "flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors",
                i === activeIndex ? "bg-hover" : "hover:bg-hover/60",
              )}
            >
              <span className="flex items-center gap-2">
                <span className="font-mono text-sm text-text-primary">
                  /{s.name}
                  {s.argumentHint ? (
                    <span className="ml-1 text-text-secondary">{s.argumentHint}</span>
                  ) : null}
                </span>
                <span className="truncate text-[11px] text-text-secondary">
                  {s.plugin}
                </span>
              </span>
              <span className="line-clamp-2 text-xs text-text-secondary">
                {s.description}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default Composer;
