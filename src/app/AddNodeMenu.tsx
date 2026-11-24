/**
 * Picking a node to add: the kinds first, then the backend's stages by
 * category, all behind one search field.
 *
 * The same list opens from the "+" button, a double click on the canvas, a
 * wire dropped on empty canvas and the "+" on an edge, so there is one place
 * to learn. A kind the backend cannot run is listed, greyed, with the reason,
 * so its absence is explained instead of a mystery.
 */
import { Command } from "cmdk";

import { t, has } from "@/core/i18n.js";
import { KINDS, StageKind } from "@/core/kinds.js";
import { canContinue } from "@/core/wiring.js";
import { cn } from "@/ui/kit";

import { useEditor } from "./context";
import { KindIcon, NodeIcon } from "./kindIcon";

export interface NodeSpec {
  type: string;
  extra: Record<string, unknown>;
}

const item = cn(
  "flex h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2 text-[13px] outline-none",
  "data-[selected=true]:bg-surface-2 data-[disabled=true]:opacity-40",
);

export function AddNodeMenu({ onPick, onlyContinuing = false, autoFocus = true }:
  { onPick: (spec: NodeSpec) => void; onlyContinuing?: boolean; autoFocus?: boolean }) {
  const editor = useEditor();
  const env = { stages: editor.stages, backend: editor.backend };
  const kinds = [...KINDS.values()].filter((kind: any) => kind !== StageKind);
  const categories: Map<string, any[]> = editor.stages.byCategory();
  const fits = (type: string, extra = {}) => !onlyContinuing || canContinue(type, extra);
  const categoryTitle = (name: string) => (has(`category.${name}`) ? t(`category.${name}`) : name);

  return (
    <Command className="flex max-h-[min(440px,60vh)] w-[320px] flex-col" loop>
      <div className="border-b border-border px-3">
        <Command.Input autoFocus={autoFocus} placeholder={t("app.add.search")}
          className="h-10 w-full bg-transparent text-[13px] outline-none placeholder:text-subtle" />
      </div>
      <Command.List className="overflow-y-auto p-1">
        <Command.Empty className="px-3 py-6 text-center text-[13px] text-muted">{t("app.add.nothing")}</Command.Empty>
        <Command.Group heading={t("app.add.kinds")}
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle">
          {kinds.filter((kind: any) => fits(kind.type)).map((kind: any) => {
            const unsupported = editor.capabilities?.supports(kind.type) === false;
            return (
              <Command.Item key={kind.type} value={`${kind.title} ${kind.type}`} className={item}
                disabled={unsupported}
                onSelect={() => onPick({ type: kind.type, extra: {} })}>
                <KindIcon type={kind.type} size={22} />
                <span className="flex-1">{kind.title}</span>
                {unsupported
                  ? <span className="truncate text-[11px] text-subtle">{editor.capabilities.reason(kind.type)}</span>
                  : <span className="font-mono text-[11px] text-subtle">{kind.type}</span>}
              </Command.Item>
            );
          })}
        </Command.Group>
        {[...categories.entries()].map(([category, specs]) => {
          const shown = specs.filter((spec: any) => fits("stage", { stage: spec.stage_name }));
          if (!shown.length) return null;
          return (
            <Command.Group key={category} heading={categoryTitle(category)}
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle">
              {shown.map((spec: any) => (
                <Command.Item key={spec.stage_name} value={`${spec.stage_name} ${spec.description ?? ""} ${category}`}
                  className={item}
                  onSelect={() => onPick({ type: "stage", extra: { stage: spec.stage_name } })}>
                  <NodeIcon node={{ id: "", type: "stage", stage: spec.stage_name }} env={env} size={22} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{spec.stage_name}</div>
                  </div>
                </Command.Item>
              ))}
            </Command.Group>
          );
        })}
      </Command.List>
    </Command>
  );
}
