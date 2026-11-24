/**
 * Ctrl+K: every action of the editor and every node of the graph, behind
 * one search field. It replaces the menu bar the old editor had: an action is
 * found by typing what it does, and shows its shortcut for next time.
 */
import { Command } from "cmdk";
import { Dialog as D } from "radix-ui";
import { useState, type ReactNode } from "react";

import { t } from "@/core/i18n.js";
import { kindOf } from "@/core/kinds.js";
import { cn } from "@/ui/kit";

import { AddNodeMenu } from "./AddNodeMenu";
import { useEditor } from "./context";
import { useDialogs } from "./dialogs/Dialogs";
import { NodeIcon } from "./kindIcon";
import { setTheme } from "./theme";

const item = cn(
  "flex h-9 cursor-default select-none items-center gap-3 rounded-md px-2.5 text-[13px] outline-none",
  "data-[selected=true]:bg-surface-2 data-[disabled=true]:opacity-40",
);
const group = "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle";

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const editor = useEditor();
  const dialogs = useDialogs();
  const [page, setPage] = useState<"root" | "add">("root");
  const close = () => { onOpenChange(false); setPage("root"); };
  const run = (fn: () => void) => () => { close(); fn(); };
  const env = { stages: editor.stages, backend: editor.backend };
  const graph = editor.model.graph;
  const runner = editor.runner;

  const Item = ({ onSelect, children, shortcut, disabled, value }:
    { onSelect: () => void; children: ReactNode; shortcut?: string; disabled?: boolean; value?: string }) => (
    <Command.Item className={item} onSelect={onSelect} disabled={disabled} value={value}>
      <span className="flex-1">{children}</span>
      {shortcut ? <span className="text-[11px] text-subtle">{shortcut}</span> : null}
    </Command.Item>
  );

  return (
    <D.Root open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/25" />
        <D.Content className="fixed left-1/2 top-[14vh] z-50 w-[min(600px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-pop outline-none">
          <D.Title className="sr-only">{t("app.cmd.title")}</D.Title>
          <D.Description className="sr-only">{t("app.cmd.placeholder")}</D.Description>
          {page === "add"
            ? <div className="[&>div]:w-full"><AddNodeMenu onPick={(spec) => { close(); editor.addNode(spec.type, spec.extra); }} /></div>
            : (
              <Command loop className="flex max-h-[min(480px,70vh)] flex-col">
                <div className="border-b border-border px-4">
                  <Command.Input autoFocus placeholder={t("app.cmd.placeholder")}
                    className="h-12 w-full bg-transparent text-[14px] outline-none placeholder:text-subtle" />
                </div>
                <Command.List className="overflow-y-auto p-1.5">
                  <Command.Empty className="px-3 py-8 text-center text-[13px] text-muted">{t("app.add.nothing")}</Command.Empty>
                  <Command.Group heading={t("app.cmd.actions")} className={group}>
                    <Item onSelect={() => setPage("add")} shortcut="A">{t("app.cmd.addNode")}</Item>
                    <Item onSelect={run(() => void editor.run({ mode: "run" }))} shortcut="F5" disabled={runner.active}>{t("run.start")}</Item>
                    <Item onSelect={run(() => void editor.run({ mode: "step" }))} shortcut="⇧F5" disabled={runner.active}>{t("run.debug")}</Item>
                    {runner.active || runner.awaitingInput ? <Item onSelect={run(() => void runner.stop())}>{t("run.stop")}</Item> : null}
                    <Item onSelect={run(() => editor.canvas?.fitView())} shortcut="⇧F">{t("view.fit")}</Item>
                    <Item onSelect={run(() => editor.model.relayout())} shortcut="⇧L">{t("view.relayout")}</Item>
                    <Item onSelect={run(() => editor.undo())} disabled={!editor.model.canUndo}>{t("edit.undo")}</Item>
                    <Item onSelect={run(() => editor.redo())} disabled={!editor.model.canRedo}>{t("edit.redo")}</Item>
                  </Command.Group>
                  <Command.Group heading={t("app.cmd.view")} className={group}>
                    {(["off", "focus", "all"] as const).map((mode) => (
                      <Item key={mode} onSelect={run(() => editor.setDataMode(mode))} value={`wires ${mode} ${t(`view.wires.${mode}`)}`}>
                        {t("view.wires")}: {t(`view.wires.${mode}`)} {editor.dataMode === mode ? "✓" : ""}
                      </Item>
                    ))}
                    <Item onSelect={run(() => editor.toggleDescriptions())}>
                      {t("view.descriptions")} {editor.showDescriptions ? "✓" : ""}
                    </Item>
                    <Item onSelect={run(() => setTheme("light"))}>{t("app.theme")}: {t("app.theme.light")}</Item>
                    <Item onSelect={run(() => setTheme("dark"))}>{t("app.theme")}: {t("app.theme.dark")}</Item>
                    <Item onSelect={run(() => setTheme("system"))}>{t("app.theme")}: {t("app.theme.system")}</Item>
                  </Command.Group>
                  <Command.Group heading={t("app.cmd.file")} className={group}>
                    <Item onSelect={run(() => dialogs.newPipeline())}>{t("file.new")}</Item>
                    <Item onSelect={run(() => dialogs.open("import"))}>{t("file.import")}</Item>
                    <Item onSelect={run(() => dialogs.open("export"))}>{t("file.export")}</Item>
                    <Item onSelect={run(() => dialogs.open("settings"))}>{t("file.settings")}</Item>
                    <Item onSelect={run(() => dialogs.open("secrets"))}>{t("file.secrets")}</Item>
                    <Item onSelect={run(() => dialogs.open("stages"))}>{t("file.registry")}</Item>
                    <Item onSelect={run(() => dialogs.open("connection"))}>{t("file.connection")}</Item>
                    <Item onSelect={run(() => dialogs.open("subpipeline"))}>{t("app.graph.new")}</Item>
                  </Command.Group>
                  {graph.nodes.length
                    ? (
                      <Command.Group heading={t("app.cmd.nodes")} className={group}>
                        {graph.nodes.map((node: any) => (
                          <Command.Item key={node.id} value={`node ${node.id} ${kindOf(node).subtitle(node, env)}`} className={item}
                            onSelect={run(() => editor.reveal({ graph: editor.model.graphKey, node: node.id, message: "" }))}>
                            <NodeIcon node={node} env={env} size={20} />
                            <span className="font-mono text-[12.5px]">{node.id}</span>
                            <span className="truncate text-[12px] text-subtle">{kindOf(node).subtitle(node, env)}</span>
                          </Command.Item>
                        ))}
                      </Command.Group>
                    )
                    : null}
                </Command.List>
              </Command>
            )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
