"use client";

import { useEffect, useState } from "react";
import { useProjectStore } from "@/store/projects";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

export interface ProjectInstructionsModalProps {
  open: boolean;
  projectId: string;
  instructions: string | null;
  onClose: () => void;
}

/**
 * "Instructions" pop-up for a project. A single large textarea;
 * the value is injected into the system prompt of every chat in the project.
 */
export function ProjectInstructionsModal({
  open,
  projectId,
  instructions,
  onClose,
}: ProjectInstructionsModalProps) {
  const update = useProjectStore((s) => s.update);
  const saving = useProjectStore((s) => s.saving);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (open) setValue(instructions ?? "");
  }, [open, instructions]);

  async function save() {
    const ok = await update(projectId, { instructions: value.trim() || null });
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Instructions" className="max-w-xl">
      <div className="flex flex-col gap-3 p-5">
        <p className="text-sm text-text-secondary">
          Tell the assistant how to behave in this project. These instructions are
          added to every chat in the project and take precedence over your global
          preferences.
        </p>
        <textarea
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={9}
          placeholder="e.g. Write in a friendly, concise brand voice. Prefer active voice. Always end with a clear call to action."
          className="w-full resize-y rounded-2xl border border-border bg-main px-4 py-3 text-sm text-text-primary placeholder:text-text-secondary focus:border-text-secondary focus:outline-none"
        />
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={save} loading={saving}>
            Save instructions
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default ProjectInstructionsModal;
