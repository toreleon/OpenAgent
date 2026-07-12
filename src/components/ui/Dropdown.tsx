"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export interface DropdownProps {
  /** The element that toggles the menu. */
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  /** Horizontal alignment of the menu relative to the trigger. */
  align?: "start" | "end";
  /** Vertical placement of the menu relative to the trigger. */
  side?: "top" | "bottom";
  className?: string;
  menuClassName?: string;
  /** When true, the trigger does not open the menu. */
  disabled?: boolean;
}

/**
 * Accessible-ish dropdown menu primitive. Closes on outside click and Escape.
 * The `children` render-prop receives a `close` callback so menu items can
 * dismiss the menu after acting.
 */
export function Dropdown({
  trigger,
  children,
  align = "start",
  side = "bottom",
  className,
  menuClassName,
  disabled,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", className)}>
      <div
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (!disabled) setOpen((o) => !o);
        }}
      >
        {trigger}
      </div>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute z-50 min-w-[12rem] animate-fade-in rounded-xl border border-border bg-sidebar p-1.5 shadow-2xl",
            side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5",
            align === "end" ? "right-0" : "left-0",
            menuClassName,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export interface DropdownItemProps {
  onClick?: () => void;
  children: ReactNode;
  /** Destructive styling (red text). */
  danger?: boolean;
  active?: boolean;
  className?: string;
}

export function DropdownItem({
  onClick,
  children,
  danger,
  active,
  className,
}: DropdownItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-hover",
        danger ? "text-danger" : "text-text-primary",
        active && "bg-hover",
        className,
      )}
    >
      {children}
    </button>
  );
}

export default Dropdown;
