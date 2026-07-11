"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowUp, FileText, Square, X } from "lucide-react";
import type { Attachment, ComposerProps } from "@/lib/types";
import FileUpload from "@/components/upload/FileUpload";
import { ModelPicker } from "./ModelPicker";
import { ReasoningEffortPicker } from "./ReasoningEffortPicker";
import { DeepResearchToggle } from "./DeepResearchToggle";
import { useChatStore } from "@/store/chat";
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
  /** Hide the "ChatGPT can make mistakes" line (e.g. on the project home). */
  hideDisclaimer?: boolean;
}

/** ChatGPT-style bottom input bar with auto-growing textarea + attachments. */
export function Composer({
  onSend,
  isStreaming,
  onStop,
  disabled,
  placeholder = "Message ChatGPT",
  model,
  onModelChange,
  draft,
  onDraftConsumed,
  hideDisclaimer,
}: ComposerFullProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const deepResearch = useChatStore((s) => s.deepResearch);
  const effectivePlaceholder = deepResearch
    ? "Ask a research question…"
    : placeholder;

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
      <div className="mx-auto w-full max-w-chat">
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
              placeholder={effectivePlaceholder}
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

          {/* Footer row: model picker + reasoning effort */}
          <div className="flex items-center justify-between px-2.5 pb-1.5">
            <div className="flex flex-wrap items-center gap-0.5">
              <ModelPicker
                value={model}
                onChange={onModelChange}
                disabled={isStreaming}
                side="top"
                align="start"
              />
              <ReasoningEffortPicker disabled={isStreaming} side="top" align="start" />
              <DeepResearchToggle disabled={isStreaming} />
            </div>
          </div>
        </div>

        {!hideDisclaimer && (
          <p className="mt-2 text-center text-xs text-text-secondary">
            ChatGPT can make mistakes. Check important info.
          </p>
        )}
      </div>
    </div>
  );
}

export default Composer;
