"use client";

import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

type Size = "sm" | "md" | "lg";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible label; rendered as aria-label and title. */
  label: string;
  size?: Size;
  active?: boolean;
}

const sizeClasses: Record<Size, string> = {
  sm: "h-7 w-7",
  md: "h-9 w-9",
  lg: "h-10 w-10",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ label, size = "md", active, className, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors motion-press hover:bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-text-secondary/50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
          active && "bg-hover text-text-primary",
          sizeClasses[size],
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

export default IconButton;
