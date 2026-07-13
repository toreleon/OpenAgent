"use client";

import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { useUserStore } from "@/store/user";
import { Button } from "@/components/ui/Button";
import {
  ConfirmDialog,
  RowButton,
  SettingRow,
  SettingsPanel,
} from "./primitives";

/** Account tab: plan, identity, session, and destructive account actions. */
export function AccountTab({ onClose }: { onClose: () => void }) {
  const profile = useUserStore((s) => s.profile);
  const save = useUserStore((s) => s.save);
  const saving = useUserStore((s) => s.saving);
  const deleteAccount = useUserStore((s) => s.deleteAccount);

  const [name, setName] = useState(profile?.name ?? "");
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Reseed the name field whenever the loaded profile changes (e.g. after load).
  useEffect(() => {
    setName(profile?.name ?? "");
  }, [profile?.name]);

  const trimmedName = name.trim();
  const nameChanged = trimmedName !== (profile?.name ?? "");

  async function handleSaveName() {
    if (!trimmedName || !nameChanged) return;
    await save({ name: trimmedName });
  }

  // Delete the account server-side, then sign the (now-gone) user out.
  async function handleDeleteAccount() {
    setDeleting(true);
    const ok = await deleteAccount();
    setDeleting(false);
    if (ok) void signOut({ callbackUrl: "/login" });
    else setConfirming(false);
  }

  // Close the settings modal as we hand off to the sign-out redirect.
  function handleSignOut() {
    onClose();
    void signOut({ callbackUrl: "/login" });
  }

  return (
    <SettingsPanel title="Account">
      <SettingRow
        label="Plan"
        description="OpenAgent Free"
        control={
          <RowButton onClick={() => {}} disabled>
            Upgrade
          </RowButton>
        }
      />

      <SettingRow
        label="Email"
        control={
          <span className="text-sm text-text-secondary">
            {profile?.email ?? "—"}
          </span>
        }
      />

      <SettingRow
        label="Name"
        control={
          <div className="flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              disabled={!profile}
              className="w-52 rounded-lg border border-border bg-main px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary focus:border-text-secondary focus:outline-none disabled:opacity-50"
            />
            {nameChanged && (
              <Button
                size="sm"
                onClick={handleSaveName}
                loading={saving}
                disabled={!trimmedName}
              >
                Save
              </Button>
            )}
          </div>
        }
      />

      <SettingRow
        label="Sign out"
        description="Sign out of this account on this device."
        control={<RowButton onClick={handleSignOut}>Sign out</RowButton>}
      />

      <SettingRow
        label="Delete account"
        description="Permanently delete your account and all associated data."
        control={
          <RowButton danger onClick={() => setConfirming(true)}>
            Delete account
          </RowButton>
        }
      />

      <ConfirmDialog
        open={confirming}
        title="Delete account"
        message={
          <>
            This permanently deletes your account and everything in it — chats,
            memories, and settings. This cannot be undone. Type your email
            address below to confirm.
          </>
        }
        confirmLabel="Delete account"
        danger
        requireText={profile?.email ?? "DELETE"}
        loading={deleting}
        onConfirm={handleDeleteAccount}
        onClose={() => setConfirming(false)}
      />
    </SettingsPanel>
  );
}

export default AccountTab;
