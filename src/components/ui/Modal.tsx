"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "./cn";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Themed modal primitive. Renders a fixed dimming overlay and a centered panel.
 * Closes on Escape, overlay click, and the X button. While open it locks body
 * scroll. Mirrors the dependency-light, semantic-token style of the other ui/
 * primitives — no portal, no focus-trap library.
 */
export function Modal({ open, onClose, title, children, className }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
    // The listener is (re)bound only when the modal opens/closes; including
    // onClose would re-run this effect (re-toggling body scroll) on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 animate-fade-in"
      onMouseDown={(e) => {
        // Only close when the click started on the overlay itself, not the panel.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-main shadow-2xl animate-scale-in origin-center",
          className,
        )}
      >
        {(title || true) && (
          <div className="flex items-center justify-between gap-4 border-b border-border/60 px-5 py-4">
            <div className="min-w-0 truncate text-base font-semibold text-text-primary">
              {title}
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
            >
              <X size={18} />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export default Modal;
