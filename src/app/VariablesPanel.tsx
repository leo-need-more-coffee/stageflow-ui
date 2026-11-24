/**
 * The graph's variables: who writes each one and who reads it.
 *
 * It also shows two mistakes validation cannot: a variable nobody writes
 * (its readers get nothing) and one nobody reads (the write is wasted).
 * Hovering a row lights the variable's path up on the canvas.
 */
import { varColor } from "@/core/colors.js";
import { t } from "@/core/i18n.js";
import { kindOf } from "@/core/kinds.js";
import { cn } from "@/ui/kit";

import { useEditor } from "./context";

export function VariablesPanel() {
  const editor = useEditor();
  const graph = editor.model.graph;
  const index = new Map<string, { writers: string[]; readers: string[] }>();
  const add = (name: string, side: "writers" | "readers", id: string) => {
    if (!index.has(name)) index.set(name, { writers: [], readers: [] });
    const list = index.get(name)![side];
    if (!list.includes(id)) list.push(id);
  };
  for (const node of graph.nodes) {
    const kind = kindOf(node);
    for (const out of kind.dataOuts(node)) add(out.variable.name, "writers", node.id);
    for (const port of kind.dataIns(node)) for (const ref of port.refs ?? []) add(ref.name, "readers", node.id);
  }
  const names = [...index.keys()].sort((a, b) => a.localeCompare(b));

  const chip = (id: string) => (
    <button key={id} type="button" onClick={() => editor.selection.set({ type: "node", id })}
      className="h-5 rounded bg-surface-2 px-1.5 font-mono text-[11px] text-muted hover:text-fg">
      {id}
    </button>
  );

  return (
    <div className="flex max-h-[60vh] flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="text-[13px] font-semibold">{t("app.vars.title")}</div>
        <div className="text-[12px] text-muted">{t("app.vars.lead")}</div>
      </div>
      <div className="overflow-y-auto p-1" onMouseLeave={() => editor.highlightVariable(null)}>
        {!names.length ? <div className="px-3 py-6 text-center text-[12.5px] text-subtle">{t("app.vars.none")}</div> : null}
        {names.map((name) => {
          const { writers, readers } = index.get(name)!;
          return (
            <div key={name} onMouseEnter={() => editor.highlightVariable(name)}
              className="flex items-start gap-2.5 rounded-md px-3 py-2 hover:bg-surface-2">
              <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: varColor(name) }} />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[12.5px] font-medium">{name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {writers.length ? writers.map(chip)
                    : <span className="text-[11px] text-bad" title={t("panel.varNoWriter")}>{t("app.vars.noWriter")}</span>}
                  <span className="px-0.5 text-subtle">→</span>
                  {readers.length ? readers.map(chip)
                    : <span className={cn("text-[11px] text-subtle")} title={t("panel.varNoReader")}>{t("app.vars.noReader")}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
