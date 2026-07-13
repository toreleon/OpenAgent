"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AlertCircle } from "lucide-react";
import type { ProjectIconName, ProjectSummary } from "@/lib/types";
import { useProjectStore } from "@/store/projects";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { ProjectIcon, PROJECT_ICON_OPTIONS } from "./projectVisuals";

export interface ProjectFormProps {
  open: boolean;
  /** When set, the dialog renames this project; otherwise it creates a new one. */
  project: ProjectSummary | null;
  onClose: () => void;
  /** Called with the created project's id (create mode only). */
  onCreated?: (id: string) => void;
}

/**
 * Project naming dialog. Creation is name-only — instructions and
 * files are added on the project page. Editing reuses it as "Rename project".
 */
export function ProjectForm({ open, project, onClose, onCreated }: ProjectFormProps) {
  const create = useProjectStore((s) => s.create);
  const update = useProjectStore((s) => s.update);
  const saving = useProjectStore((s) => s.saving);

  const [name, setName] = useState("");
  const [icon, setIcon] = useState<ProjectIconName>("folder");
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isEdit = !!project;

  useEffect(() => {
    if (!open) return;
    setLocalError(null);
    setName(project?.name ?? "");
    setIcon(project?.icon ?? "folder");
    // Focus + select after the modal mounts.
    requestAnimationFrame(() => inputRef.current?.select());
  }, [open, project]);

  const canSubmit = name.trim().length > 0 && !saving;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setLocalError(null);
    const trimmed = name.trim();

    if (project) {
      const ok = await update(project.id, { name: trimmed, icon });
      if (ok) onClose();
      else setLocalError(useProjectStore.getState().error || "Failed to rename project");
      return;
    }

    const created = await create({ name: trimmed, icon });
    if (created) {
      onClose();
      onCreated?.(created.id);
    } else {
      setLocalError(useProjectStore.getState().error || "Failed to create project");
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? "Rename project" : "New project"}
      className="max-w-md"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-text-secondary">
            <ProjectIcon icon={icon} size={22} />
          </span>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
            className="min-w-0 flex-1 rounded-xl border border-border bg-main px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary focus:border-text-secondary focus:outline-none"
          />
        </div>
        <p className="text-xs text-text-secondary">
          Choose a meaningful name to identify this project later. You can add
          instructions and files once it&apos;s created.
        </p>

        <fieldset>
          <legend className="mb-2 text-xs font-medium text-text-secondary">
            Project icon
          </legend>
          <div className="grid grid-cols-5 gap-1.5">
            {PROJECT_ICON_OPTIONS.map((option) => {
              const selected = icon === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-label={option.label}
                  aria-pressed={selected}
                  title={option.label}
                  onClick={() => setIcon(option.id)}
                  className={`flex h-9 items-center justify-center rounded-lg border transition-colors ${
                    selected
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-border text-text-secondary hover:bg-hover hover:text-text-primary"
                  }`}
                >
                  <ProjectIcon icon={option.id} size={18} />
                </button>
              );
            })}
          </div>
        </fieldset>

        {localError && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-danger">
            <AlertCircle size={15} className="shrink-0" />
            <span className="min-w-0 flex-1">{localError}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canSubmit} loading={saving}>
            {isEdit ? "Rename" : "Create project"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default ProjectForm;
