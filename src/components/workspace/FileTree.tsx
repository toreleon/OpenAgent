"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/components/ui/cn";
import type { WorkspaceTreeFile } from "@/lib/workspace/types";

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  children: Map<string, TreeNode>;
}

/** Fold a flat file list into a nested tree (no tree library). */
function buildTree(files: WorkspaceTreeFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isDir: true, children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const name = parts[i];
      let node = cur.children.get(name);
      if (!node) {
        node = {
          name,
          path: parts.slice(0, i + 1).join("/"),
          isDir: !isLast,
          size: isLast ? f.size : undefined,
          children: new Map(),
        };
        cur.children.set(name, node);
      }
      cur = node;
    }
  }
  return root;
}

/** Dirs first, then files; each alphabetical. */
function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Zero-dependency recursive file tree for BROWSE mode. Dirs expand/collapse;
 * clicking a file opens it read-only in the right column.
 */
export function FileTree({
  files,
  selectedPath,
  onSelect,
}: {
  files: WorkspaceTreeFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const root = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  if (files.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-text-secondary">
        Workspace is empty.
      </div>
    );
  }

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const pad = { paddingLeft: `${8 + depth * 12}px` };
    if (node.isDir) {
      const open = !collapsed.has(node.path);
      return (
        <li key={node.path}>
          <button
            type="button"
            onClick={() => toggle(node.path)}
            style={pad}
            className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs text-text-primary transition-colors hover:bg-hover/50"
          >
            {open ? (
              <ChevronDown size={13} className="shrink-0 text-text-secondary" />
            ) : (
              <ChevronRight size={13} className="shrink-0 text-text-secondary" />
            )}
            {open ? (
              <FolderOpen size={14} className="shrink-0 text-text-secondary" />
            ) : (
              <Folder size={14} className="shrink-0 text-text-secondary" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
          {open && (
            <ul>{sortedChildren(node).map((c) => renderNode(c, depth + 1))}</ul>
          )}
        </li>
      );
    }
    return (
      <li key={node.path}>
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          style={pad}
          className={cn(
            "flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs transition-colors",
            selectedPath === node.path
              ? "bg-hover text-text-primary"
              : "text-text-primary hover:bg-hover/50",
          )}
        >
          <span className="w-[13px] shrink-0" />
          <File size={14} className="shrink-0 text-text-secondary" />
          <span className="truncate">{node.name}</span>
        </button>
      </li>
    );
  };

  return <ul className="py-1 stagger-children">{sortedChildren(root).map((c) => renderNode(c, 0))}</ul>;
}

export default FileTree;
