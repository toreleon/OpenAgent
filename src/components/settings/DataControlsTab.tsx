"use client";

import { useState } from "react";
import { AlertCircle } from "lucide-react";
import { useSettingsStore } from "@/store/settings";
import { useUserStore } from "@/store/user";
import {
  SettingsPanel,
  SettingRow,
  Toggle,
  RowButton,
  ConfirmDialog,
} from "./primitives";

/** Data controls tab: training opt-out, chat management, and account exports. */
export function DataControlsTab() {
  const improveModel = useSettingsStore((s) => s.prefs.improveModel);
  const setPref = useSettingsStore((s) => s.setPref);

  const error = useUserStore((s) => s.error);
  const clearError = useUserStore((s) => s.clearError);
  const deleteAllChats = useUserStore((s) => s.deleteAllChats);
  const exportData = useUserStore((s) => s.exportData);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  function openDeleteAll() {
    clearError();
    setConfirmOpen(true);
  }

  async function handleDeleteAll() {
    setDeleting(true);
    const ok = await deleteAllChats();
    setDeleting(false);
    if (ok) setConfirmOpen(false);
  }

  async function handleExport() {
    setExporting(true);
    await exportData();
    setExporting(false);
  }

  return (
    <SettingsPanel title="Data controls">
      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-danger">
          <AlertCircle size={15} className="shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}

      <SettingRow
        label="Improve the model for everyone"
        description="Allow your content to be used to train our models."
        control={
          <Toggle
            checked={improveModel}
            onChange={(next) => setPref("improveModel", next)}
            label="Improve the model for everyone"
          />
        }
      />

      {/* Sharing/archiving live server-side and aren't wired in this template. */}
      <SettingRow
        label="Shared links"
        control={
          <RowButton onClick={() => {}} disabled>
            Manage
          </RowButton>
        }
      />

      <SettingRow
        label="Archived chats"
        control={
          <RowButton onClick={() => {}} disabled>
            Manage
          </RowButton>
        }
      />

      <SettingRow
        label="Archive all chats"
        control={
          <RowButton onClick={() => {}} disabled>
            Archive all
          </RowButton>
        }
      />

      <SettingRow
        label="Delete all chats"
        control={
          <RowButton danger onClick={openDeleteAll}>
            Delete all
          </RowButton>
        }
      />

      <SettingRow
        label="Export data"
        description="Download a JSON archive of your account and chats."
        control={
          <RowButton onClick={handleExport} loading={exporting}>
            Export
          </RowButton>
        }
      />

      <ConfirmDialog
        open={confirmOpen}
        title="Delete all chats?"
        message="This will permanently delete all of your chats. This action cannot be undone."
        confirmLabel="Delete all"
        danger
        loading={deleting}
        onConfirm={handleDeleteAll}
        onClose={() => setConfirmOpen(false)}
      />
    </SettingsPanel>
  );
}

export default DataControlsTab;
