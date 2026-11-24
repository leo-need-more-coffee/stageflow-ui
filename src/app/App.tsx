/**
 * The editor's window: the bar on top, the canvas, the form of what is
 * selected on the right, and the run at the bottom while there is one.
 */
import { useEffect, useState } from "react";

import { TooltipProvider } from "@/ui/kit";

import { Canvas } from "./canvas/Canvas";
import { CommandPalette } from "./CommandPalette";
import { EditorContext, useEditor } from "./context";
import { DialogsProvider } from "./dialogs/Dialogs";
import type { Editor } from "./editor";
import { Inspector } from "./inspector/Inspector";
import { RunPanel } from "./run/RunPanel";
import { StatusNotes } from "./StatusNotes";
import { Toaster } from "./Toaster";
import { TopBar } from "./TopBar";

/** The letter of a key whatever the keyboard layout, so Ctrl+Z works in Russian too. */
function letterOf(e: KeyboardEvent) {
  return e.code?.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
}

function typing(target: EventTarget | null) {
  return target instanceof HTMLElement
    && (target.matches("input, textarea, select") || target.isContentEditable);
}

function useShortcuts(editor: Editor, openPalette: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = letterOf(e);
      if (mod && key === "k") {
        e.preventDefault();
        openPalette();
        return;
      }
      if (typing(e.target) || document.querySelector("[role=dialog]")) return;
      if (mod && !e.altKey) {
        if (key === "z") {
          e.preventDefault();
          if (!e.shiftKey && editor.revertChange()) return;
          if (e.shiftKey) editor.redo(); else editor.undo();
          return;
        }
        if (key === "y") { e.preventDefault(); editor.redo(); return; }
        if (key === "d") { e.preventDefault(); editor.duplicateSelection(); return; }
        if (key === "a") { e.preventDefault(); editor.selection.setNodes(editor.model.graph.nodes.map((n: any) => n.id)); return; }
        if (key === "c" || key === "x" || key === "v") {
          if (key === "v" ? editor.clipboard.length : editor.selection.nodes.size) {
            e.preventDefault();
            if (key === "c") editor.copySelection();
            else if (key === "x") editor.cutSelection();
            else editor.paste();
          }
          return;
        }
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        void editor.run({ mode: e.shiftKey ? "step" : "run" });
        return;
      }
      if (e.key === "F10" && editor.runner.active) {
        e.preventDefault();
        void editor.runner.step();
        return;
      }
      if (e.shiftKey && key === "f") { e.preventDefault(); editor.canvas?.fitView(); return; }
      if (e.shiftKey && key === "l") { e.preventDefault(); editor.model.relayout(); return; }
      if (!e.shiftKey && !e.altKey && key === "a") {
        e.preventDefault();
        editor.dispatchEvent(new Event("open-add"));
        return;
      }
      if (e.key === "Escape") {
        if (editor.revertChange()) return;
        editor.selection.clear();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && editor.selection.current) {
        e.preventDefault();
        editor.deleteSelection();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editor, openPalette]);
}

function Shell() {
  const editor = useEditor();
  const [palette, setPalette] = useState(false);
  useShortcuts(editor, () => setPalette(true));
  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <TopBar onCommand={() => setPalette(true)} />
      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1 bg-canvas">
          <Canvas />
          <StatusNotes />
        </main>
        <Inspector />
      </div>
      <RunPanel />
      <CommandPalette open={palette} onOpenChange={setPalette} />
      <Toaster />
    </div>
  );
}

export function App({ editor }: { editor: Editor }) {
  return (
    <EditorContext.Provider value={editor}>
      <TooltipProvider delayDuration={400}>
        <DialogsProvider>
          <Shell />
        </DialogsProvider>
      </TooltipProvider>
    </EditorContext.Provider>
  );
}
