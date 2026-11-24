import { AlertCircle, CheckCircle2, Info } from "lucide-react";

import { cn } from "@/ui/kit";

import { useEditor } from "./context";

/** Short notes in the corner: copied, pasted, a run that would not start. */
export function Toaster() {
  const editor = useEditor();
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2">
      {editor.toasts.map((toast) => (
        <div key={toast.id} className={cn(
          "pointer-events-auto flex max-w-[560px] items-start gap-2 rounded-lg border bg-surface px-3 py-2 text-[13px] shadow-pop",
          toast.tone === "bad" ? "border-bad/30" : "border-border",
        )}>
          {toast.tone === "bad" ? <AlertCircle size={15} className="mt-0.5 shrink-0 text-bad" />
            : toast.tone === "ok" ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ok" />
            : <Info size={15} className="mt-0.5 shrink-0 text-muted" />}
          <span>{toast.text}</span>
        </div>
      ))}
    </div>
  );
}
