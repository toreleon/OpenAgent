"use client";

import { signOut } from "next-auth/react";
import { LogOut } from "lucide-react";

export interface SignOutButtonProps {
  /** Optional extra classes to merge with the default styling. */
  className?: string;
}

/**
 * Sign-out control. Signs the user out and redirects to /login.
 * Reusable from the sidebar / account menu (Chat-UI imports this).
 */
export default function SignOutButton({ className }: SignOutButtonProps) {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: "/login" })}
      className={
        className ??
        "motion-press flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
      }
    >
      <LogOut className="h-4 w-4" />
      Log out
    </button>
  );
}
