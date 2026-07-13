"use client";

import { useEffect, useState } from "react";
import {
  Bell,
  CircleUser,
  Database,
  Lock,
  Package,
  Plug,
  Sparkles,
  SlidersHorizontal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/components/ui/cn";
import { useSettingsStore } from "@/store/settings";
import { useUserStore } from "@/store/user";
import { GeneralTab } from "./GeneralTab";
import { NotificationsTab } from "./NotificationsTab";
import { PersonalizationTab } from "./PersonalizationTab";
import { ConnectorsTab } from "./ConnectorsTab";
import { PluginsTab } from "./PluginsTab";
import { DataControlsTab } from "./DataControlsTab";
import { SecurityTab } from "./SecurityTab";
import { AccountTab } from "./AccountTab";

export type SettingsTab =
  | "general"
  | "notifications"
  | "personalization"
  | "connectors"
  | "plugins"
  | "data"
  | "security"
  | "account";

const TABS: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "personalization", label: "Personalization", icon: Sparkles },
  { id: "connectors", label: "Connectors", icon: Plug },
  { id: "plugins", label: "Plugins", icon: Package },
  { id: "data", label: "Data controls", icon: Database },
  { id: "security", label: "Security", icon: Lock },
  { id: "account", label: "Account", icon: CircleUser },
];

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** Which tab to open on (e.g. "personalization" for "Customize OpenAgent"). */
  initialTab?: SettingsTab;
}

export function SettingsModal({ open, onClose, initialTab }: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "general");

  const hydrate = useSettingsStore((s) => s.hydrate);
  const loadUser = useUserStore((s) => s.load);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab ?? "general");
    hydrate();
    void loadUser();
  }, [open, initialTab, hydrate, loadUser]);

  return (
    <Modal open={open} onClose={onClose} title="Settings" className="max-w-3xl">
      <div className="flex h-[32rem]">
        {/* Left tab rail */}
        <nav className="w-48 shrink-0 space-y-0.5 overflow-y-auto border-r border-border/60 p-2.5">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                  tab === t.id
                    ? "bg-hover text-text-primary"
                    : "text-text-secondary hover:bg-hover hover:text-text-primary",
                )}
              >
                <Icon size={16} className="shrink-0" />
                {t.label}
              </button>
            );
          })}
        </nav>

        {/* Content pane */}
        <div className="min-w-0 flex-1 overflow-hidden p-5">
          {tab === "general" && <GeneralTab />}
          {tab === "notifications" && <NotificationsTab />}
          {tab === "personalization" && <PersonalizationTab />}
          {tab === "connectors" && <ConnectorsTab />}
          {tab === "plugins" && <PluginsTab />}
          {tab === "data" && <DataControlsTab />}
          {tab === "security" && <SecurityTab />}
          {tab === "account" && <AccountTab onClose={onClose} />}
        </div>
      </div>
    </Modal>
  );
}

export default SettingsModal;
