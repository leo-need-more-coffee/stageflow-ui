import { Check, Undo2 } from "lucide-react";

import { t } from "@/core/i18n.js";
import { Button, Tip } from "@/ui/kit";

import { useEditor } from "./context";

/** A catalog label without its own leading symbol, for a button with an icon. */
const plain = (text: string) => text.replace(/^[^\p{L}\p{N}]+/u, "");

/**
 * What something other than the user is doing to the graph: the agent bridge
 * and the changes it pushed, with Keep and Revert. Floats over the canvas
 * only while there is something to say.
 */
export function StatusNotes() {
  const editor = useEditor();
  const notes = [...editor.notes.entries()];
  if (!notes.length && !editor.pending) return null;
  return (
    <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5 shadow-pop">
      {notes.map(([owner, note]) => (
        <Tip key={owner} content={note.title}>
          {note.onClick
            ? <Button size="sm" variant="ghost" onClick={note.onClick}>{note.text}</Button>
            : <span className="px-2 text-[12.5px] text-muted">{note.text}</span>}
        </Tip>
      ))}
      {editor.pending
        ? (
          <>
            <Tip content={t("review.keep.hint")}>
              <Button size="sm" variant="primary" onClick={() => editor.acceptChange()}><Check /> {plain(t("review.keep"))}</Button>
            </Tip>
            <Tip content={t("review.back.hint")}>
              <Button size="sm" onClick={() => editor.revertChange()}><Undo2 /> {plain(t("review.back"))}</Button>
            </Tip>
          </>
        )
        : null}
    </div>
  );
}
