"use client";

import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { useChatStore } from "@/store/chat";
import { ArtifactLibrary } from "./ArtifactLibrary";

const COLLAPSED_SIDEBAR_WIDTH = 52;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 420;

/** App shell for the dedicated Artifacts workspace. */
export function ArtifactsApp() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const loadConversations = useChatStore((state) => state.loadConversations);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    document.body.classList.add("select-none");

    const onMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(
        Math.min(
          SIDEBAR_MAX_WIDTH,
          Math.max(SIDEBAR_MIN_WIDTH, startWidth + moveEvent.clientX - startX),
        ),
      );
    };
    const onEnd = () => {
      document.body.style.cursor = previousCursor;
      document.body.classList.remove("select-none");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd, { once: true });
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-main">
      <div
        className="relative h-full shrink-0 overflow-visible border-r border-border/60 transition-[width] duration-200"
        style={{ width: sidebarOpen ? sidebarWidth : COLLAPSED_SIDEBAR_WIDTH }}
      >
        <div className="h-full overflow-hidden">
          <Sidebar open={sidebarOpen} onToggle={() => setSidebarOpen((open) => !open)} />
        </div>
        {sidebarOpen && (
          <div
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            onPointerDown={startSidebarResize}
            className="absolute -right-1 top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none hover:bg-accent/20 lg:block"
          />
        )}
      </div>
      <ArtifactLibrary />
    </div>
  );
}

export default ArtifactsApp;
