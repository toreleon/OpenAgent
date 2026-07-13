"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";

/** A settings tab body: a title/subtitle header + stacked rows. */
export function SettingsPanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="mb-1">
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
        {description && (
          <p className="mt-0.5 text-sm text-text-secondary">{description}</p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

/** A label-left / control-right row with a hairline divider. */
export function SettingRow({
  label,
  description,
  control,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 border-b border-border/50 py-3.5",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-sm text-text-primary">{label}</div>
        {description && (
          <div className="mt-0.5 text-xs text-text-secondary">{description}</div>
        )}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

/** A bold group subheader within a tab (e.g. "Memory"). */
export function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-1 mt-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
      {children}
    </h3>
  );
}

/** iOS-style pill toggle. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-text-secondary/50 disabled:opacity-50",
        checked ? "bg-accent" : "bg-border",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/** A compact bordered dropdown (native select styled as a pill). */
export function SelectControl({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "cursor-pointer rounded-lg border border-border bg-main px-3 py-1.5 text-sm text-text-primary focus:border-text-secondary focus:outline-none",
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A secondary button used for "Manage" / "Export" / neutral row actions. */
export function RowButton({
  children,
  onClick,
  danger,
  loading,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50",
        danger
          ? "border-red-500/40 text-red-400 hover:bg-red-500/10"
          : "border-border text-text-primary hover:bg-hover",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Confirmation dialog for destructive actions. When `requireText` is set the
 * confirm button stays disabled until the user types that exact string
 * (type-to-confirm for account deletion).
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger = true,
  requireText,
  loading,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  requireText?: string;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (open) setText("");
  }, [open]);
  const canConfirm = !requireText || text === requireText;

  return (
    <Modal open={open} onClose={onClose} title={title} className="max-w-md">
      <div className="flex flex-col gap-4 p-5">
        <div className="text-sm text-text-secondary">{message}</div>
        {requireText && (
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={requireText}
            autoFocus
            className="w-full rounded-lg border border-border bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-text-secondary focus:outline-none"
          />
        )}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <button
            type="button"
            disabled={!canConfirm || loading}
            onClick={onConfirm}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
              danger
                ? "bg-red-500 text-white hover:bg-red-600"
                : "bg-text-primary text-main hover:opacity-90",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
