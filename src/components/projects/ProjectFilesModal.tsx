"use client";

import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { FileText, Trash2, Upload } from "lucide-react";
import { MAX_PROJECT_FILES, type ProjectFileInfo } from "@/lib/types";
import { useProjectStore } from "@/store/projects";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";

export interface ProjectFilesModalProps {
  open: boolean;
  projectId: string;
  files: ProjectFileInfo[];
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * "Project files" pop-up. Drag-and-drop or browse to add
 * knowledge files shared with every chat in the project; text is extracted and
 * injected as context. Files without extractable text are flagged "Not indexed".
 */
export function ProjectFilesModal({
  open,
  projectId,
  files,
  onClose,
}: ProjectFilesModalProps) {
  const uploadFiles = useProjectStore((s) => s.uploadFiles);
  const removeFile = useProjectStore((s) => s.removeFile);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const full = files.length >= MAX_PROJECT_FILES;

  async function add(list: FileList | null) {
    if (!list || list.length === 0) return;
    setUploading(true);
    await uploadFiles(projectId, Array.from(list));
    setUploading(false);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (!full) void add(e.dataTransfer.files);
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    void add(e.target.files);
    e.target.value = "";
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Project files (${files.length}/${MAX_PROJECT_FILES})`}
      className="max-w-xl"
    >
      <div className="flex flex-col gap-4 p-5">
        {/* Drop zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!full) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-6 py-8 text-center transition-colors",
            dragOver ? "border-text-secondary bg-hover" : "border-border",
            full && "opacity-50",
          )}
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-hover text-text-secondary">
            {uploading ? <Spinner size={18} /> : <Upload size={18} />}
          </span>
          <p className="text-sm text-text-primary">
            Drag &amp; drop files here, or{" "}
            <button
              type="button"
              disabled={full || uploading}
              onClick={() => inputRef.current?.click()}
              className="font-medium text-text-primary underline decoration-text-secondary/50 underline-offset-2 hover:decoration-text-primary disabled:no-underline disabled:opacity-50"
            >
              browse
            </button>
          </p>
          <p className="text-xs text-text-secondary">
            {full
              ? "Project file limit reached."
              : "PDF, text, Markdown, CSV and JSON are read and shared with every chat."}
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onPick}
            tabIndex={-1}
            aria-hidden="true"
          />
        </div>

        {/* File list */}
        {files.length > 0 && (
          <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
            {files.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-3 rounded-xl border border-border/60 bg-sidebar/40 px-3 py-2"
              >
                <FileText size={16} className="shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                  {f.name}
                </span>
                {!f.hasContent && (
                  <span className="shrink-0 rounded-full bg-hover px-2 py-0.5 text-[11px] text-text-secondary">
                    Not indexed
                  </span>
                )}
                <span className="shrink-0 text-xs tabular-nums text-text-secondary">
                  {formatBytes(f.size)}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => void removeFile(projectId, f.id)}
                  className="shrink-0 text-text-secondary transition-colors hover:text-red-400"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default ProjectFilesModal;
