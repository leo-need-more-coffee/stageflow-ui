import { createContext, useContext, useSyncExternalStore } from "react";

import type { Editor } from "./editor";

export const EditorContext = createContext<Editor | null>(null);

/**
 * The editor, and a redraw whenever it says something changed. Every
 * component reads the editor directly; the version number is only how React
 * learns that it should look again.
 */
export function useEditor(): Editor {
  const editor = useContext(EditorContext);
  if (!editor) throw new Error("useEditor outside an EditorContext");
  useSyncExternalStore(
    (notify) => {
      editor.addEventListener("render", notify);
      return () => editor.removeEventListener("render", notify);
    },
    () => editor.version,
  );
  return editor;
}
