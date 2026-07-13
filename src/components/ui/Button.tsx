"use client";

import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";
import { Spinner } from "./Spinner";

type Variant = "primary" | "secondary" | "ghost" | "outline";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-text-primary text-main hover:bg-text-primary/90 disabled:bg-text-primary/40",
  secondary:
    "bg-user-bubble text-text-primary hover:bg-hover disabled:opacity-50",
  ghost: "bg-transparent text-text-primary hover:bg-hover disabled:opacity-40",
  outline:
    "border border-border bg-transparent text-text-primary hover:bg-hover disabled:opacity-50",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-5 text-base",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex select-none items-center justify-center gap-2 rounded-full font-medium transition-colors motion-press focus:outline-none focus-visible:ring-2 focus-visible:ring-text-secondary/60 disabled:cursor-not-allowed",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...rest}
    >
      {loading && <Spinner size={16} />}
      {children}
    </button>
  );
});

export default Button;
