"use client";

import type { ReactNode } from "react";

/**
 * Presentational phone bezel for previewing `mobile` (and responsive web)
 * artifacts. Draws a centered device frame on a muted backdrop; the child (a
 * sandboxed iframe preview) fills the "screen". Purely cosmetic — NO isolation
 * logic lives here (that stays in SandboxFrame's `sandbox` iframe). The frame
 * keeps a phone aspect ratio and scales down to fit the available panel height.
 *
 * IMPORTANT: the wrapper renders the SAME DOM node structure whether `enabled` is
 * true or false — only class names change (the inner divs collapse to
 * `display:contents` and the notch to `display:none` when disabled). This keeps
 * the child subtree's identity stable, so toggling the viewport does NOT remount
 * the preview iframe (which would reload react-native-web from the CDN and wipe
 * the app's in-iframe state).
 */
export function DeviceFrame({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={
        enabled
          ? "flex h-full w-full items-center justify-center overflow-auto bg-code-bg p-4"
          : "h-full w-full"
      }
    >
      <div
        className={
          enabled
            ? "relative flex aspect-[390/844] h-full max-h-[860px] w-auto max-w-full shrink-0 overflow-hidden rounded-[2.25rem] border-[8px] border-neutral-800 bg-black shadow-2xl"
            : "contents"
        }
      >
        {/* status-bar notch (hidden, not removed, so node positions stay stable) */}
        <div
          className={
            enabled
              ? "pointer-events-none absolute left-1/2 top-0 z-10 h-5 w-28 -translate-x-1/2 rounded-b-2xl bg-neutral-800"
              : "hidden"
          }
        />
        <div
          className={
            enabled
              ? "h-full w-full overflow-hidden rounded-[1.75rem] bg-white"
              : "contents"
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export default DeviceFrame;
