"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
}

/** Lightweight CSS tooltip — no portal, no dependencies. */
export function Tooltip({ label, children, side = "top", className }: TooltipProps) {
  const [open, setOpen] = useState(false);

  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={cn(
            "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-text-primary px-2 py-1 text-xs font-medium text-main shadow-lg",
            side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
          )}
        >
          {label}
        </span>
      )}
    </span>
  );
}

export default Tooltip;
