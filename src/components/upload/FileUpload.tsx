"use client";

/**
 * FileUpload (owned by Agent D — Files).
 *
 * Renders a paperclip trigger + a hidden file input. On selection it uploads
 * the chosen files to `POST /api/upload` and, on success, calls
 * `onUploaded(attachments)`. It does NOT render attachment preview chips — the
 * Composer (Chat-UI) owns those.
 */

import { useId, useRef, useState, type ChangeEvent } from "react";
import { Paperclip, Loader2 } from "lucide-react";
import type { Attachment, FileUploadProps, UploadResponse } from "@/lib/types";

/** File types offered in the picker (images + common documents). */
const ACCEPT = [
  "image/*",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".txt",
  ".md",
  ".csv",
  ".rtf",
  ".json",
  ".xml",
  ".html",
  ".zip",
].join(",");

export function FileUpload({ onUploaded, disabled }: FileUploadProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  const busy = disabled || isUploading;

  function openPicker() {
    if (busy) return;
    setError(null);
    inputRef.current?.click();
  }

  async function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    const form = new FormData();
    for (const file of Array.from(fileList)) {
      form.append("files", file);
    }

    // Reset the input so selecting the same file again re-triggers change.
    e.target.value = "";

    setError(null);
    setIsUploading(true);
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        let message = `Upload failed (${res.status}).`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          /* keep the default message */
        }
        setError(message);
        return;
      }

      const data = (await res.json()) as UploadResponse;
      const attachments: Attachment[] = Array.isArray(data?.attachments)
        ? data.attachments
        : [];
      if (attachments.length > 0) {
        onUploaded(attachments);
      }
    } catch {
      setError("Network error while uploading. Please try again.");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="relative inline-flex">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={handleChange}
        disabled={busy}
        tabIndex={-1}
        aria-hidden="true"
      />
      <button
        type="button"
        onClick={openPicker}
        disabled={busy}
        aria-label="Attach files"
        aria-describedby={error ? errorId : undefined}
        title="Attach files"
        className="motion-press inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isUploading ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        ) : (
          <Paperclip className="h-5 w-5" aria-hidden="true" />
        )}
      </button>
      {error ? (
        <span
          id={errorId}
          role="alert"
          className="animate-scale-in origin-bottom absolute bottom-full left-0 mb-2 w-max max-w-xs rounded-md border border-border bg-composer px-2 py-1 text-xs text-red-400 shadow-lg"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

export default FileUpload;
