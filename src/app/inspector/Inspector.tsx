/**
 * The panel on the right: the form of what is selected.
 *
 * It is there only while something is selected, so the canvas has the whole
 * window the rest of the time. A node's form follows how the node is thought
 * about: what it does, what it takes, what it gives, where it goes next. The
 * rarely touched things (its id, retries, copies) are one tab over.
 */
import { MoreHorizontal, Trash2, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { t, tn } from "@/core/i18n.js";
import { kindOf } from "@/core/kinds.js";
import {
  Button, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tab, TabList, TabPanel, Tabs,
} from "@/ui/kit";

import { useEditor } from "../context";
import type { Editor } from "../editor";
import { NodeIcon } from "../kindIcon";
import {
  CommitInput, Field, NodeSelect, RowsField, ScalarField, SpecArgs, SpecOutputs, StageSpec, TagsField,
  ValueField, type FieldEnv,
} from "./fields";

const PORT_LABELS: Record<string, string> = {
  next: "port.next", then: "port.then", else: "port.else", default: "port.default", body: "port.body",
};

function Section({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-border px-4 py-4 last:border-b-0">
      {title ? <h3 className="text-[11px] font-semibold uppercase tracking-wide text-subtle">{title}</h3> : null}
      {children}
    </section>
  );
}

export function Inspector() {
  const editor = useEditor();
  // the drafts and the picked sources outlive a redraw of the form
  const drafts = useRef(new Map<string, any[]>()).current;
  const modes = useRef(new Map<string, any>()).current;
  const sel = editor.selection.current;
  if (!sel) return null;

  let body: ReactNode = null;
  if (sel.type === "edge") body = <EdgePanel editor={editor} from={sel.from} portIndex={sel.portIndex} />;
  else if (sel.type === "nodes") body = <NodesPanel editor={editor} ids={sel.ids} />;
  else {
    const node = editor.model.node(sel.id);
    if (!node) return null;
    body = <NodePanel key={node.id} editor={editor} node={node} drafts={drafts} modes={modes} />;
  }

  return (
    <aside className="flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-surface">
      {body}
    </aside>
  );
}

function PanelHead({ icon, title, subtitle, actions, onClose }:
  { icon?: ReactNode; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; onClose: () => void }) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-3">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold">{title}</div>
        {subtitle ? <div className="truncate text-[12px] text-muted">{subtitle}</div> : null}
      </div>
      {actions}
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("app.close")}><X /></Button>
    </div>
  );
}

function NodePanel({ editor, node, drafts, modes }:
  { editor: Editor; node: any; drafts: Map<string, any[]>; modes: Map<string, any> }) {
  const [tab, setTab] = useState("setup");
  const [renaming, setRenaming] = useState(false);
  const kind = kindOf(node);
  const kenv = { stages: editor.stages, backend: editor.backend };
  const env: FieldEnv = { editor, nodeId: node.id, touch: () => editor.model.touch() };
  const fields = kind.fields(node, { ...kenv, secrets: editor.secrets });
  const description = kind.description(node, kenv);
  const graph = editor.model.graph;
  const isEntry = graph.entry === node.id;
  const entryOwner = graph.nodes.find((n: any) => n.type === "entry");
  const ports = kind.orderPorts(node).filter((p: any) => !p.add && !p.removeItem);
  const issues = editor.issues.filter((i) => i.graph === editor.model.graphKey && i.node === node.id);

  const render = (field: any) => {
    switch (field.kind) {
      case "spec-args": return <SpecArgs field={field} env={env} />;
      case "spec-outputs": return <SpecOutputs field={field} env={env} />;
      case "rows": return <RowsField field={field} env={env} drafts={drafts} />;
      case "value": return <ValueField field={field} env={env} modes={modes} />;
      case "tags": return <TagsField field={field} env={env} />;
      case "stage-spec": return null;
      default: return <ScalarField field={field} env={env} />;
    }
  };
  const group = (key: string) => fields.filter((f: any) => (f.group ?? "main") === key);
  const stageSpec = fields.find((f: any) => f.kind === "stage-spec");

  const rename = (next: string) => {
    setRenaming(false);
    const clean = next.trim();
    if (!clean || clean === node.id) return;
    if (editor.model.renameNode(node.id, clean)) editor.selection.set({ type: "node", id: clean });
    else editor.toast(t("app.inspector.renameFailed", { id: clean }), "bad");
  };

  return (
    <>
      <PanelHead
        icon={<NodeIcon node={node} env={kenv} size={32} />}
        title={renaming
          ? <CommitInput mono autoFocus value={node.id} onCommit={rename} onBlur={() => setRenaming(false)} className="h-7" />
          : (
            <button type="button" className="max-w-full truncate rounded px-1 -mx-1 text-left font-mono hover:bg-surface-2"
              title={t("app.inspector.rename")} onClick={() => setRenaming(true)}>
              {node.id}
            </button>
          )}
        subtitle={kind.type === "stage" ? `${kind.title} · ${node.stage || "—"}` : kind.title}
        onClose={() => editor.selection.clear()}
        actions={(
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("app.more")}><MoreHorizontal /></Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem shortcut="⌘D" onSelect={() => editor.duplicateSelection()}>{t("app.menu.duplicate")}</MenuItem>
              <MenuItem disabled={isEntry || Boolean(entryOwner)} onSelect={() => editor.model.setEntry(node.id)}>
                {t("app.menu.makeEntry")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem danger icon={<Trash2 />} shortcut="⌫" onSelect={() => editor.deleteSelection()}>
                {t("app.menu.delete")}
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      />

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabList>
          <Tab value="setup">{t("app.inspector.setup")}</Tab>
          <Tab value="more">{t("app.inspector.more")}</Tab>
          {stageSpec ? <Tab value="spec">{t("app.inspector.reference")}</Tab> : null}
        </TabList>

        <TabPanel value="setup" className="min-h-0 flex-1 overflow-y-auto outline-none">
          {issues.length
            ? (
              <div className="mx-4 mt-4 rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-[12px] text-bad">
                {issues.map((issue, i) => <div key={i}>{issue.message}</div>)}
              </div>
            )
            : null}
          {description ? <p className="px-4 pt-4 text-[12.5px] leading-relaxed text-muted">{description}</p> : null}
          {group("main").length ? <Section>{group("main").map((f: any, i: number) => <div key={i}>{render(f)}</div>)}</Section> : null}
          {group("in").length ? <Section title={t("group.in")}>{group("in").map((f: any, i: number) => <div key={i}>{render(f)}</div>)}</Section> : null}
          {group("out").length ? <Section title={t("group.out")}>{group("out").map((f: any, i: number) => <div key={i}>{render(f)}</div>)}</Section> : null}
          {ports.length
            ? (
              <Section title={t("group.flow")}>
                {ports.map((port: any) => {
                  const human = port.human ?? (PORT_LABELS[port.key] && t(PORT_LABELS[port.key]));
                  return (
                    <Field key={port.key + port.label} label={human ?? port.label} hint={human ? port.label : undefined}>
                      <NodeSelect env={env} value={port.get?.()} onChange={(v) => { port.set?.(v); editor.model.touch(); }} />
                    </Field>
                  );
                })}
              </Section>
            )
            : null}
        </TabPanel>

        <TabPanel value="more" className="min-h-0 flex-1 overflow-y-auto outline-none">
          <Section>
            <Field label={t("panel.nodeId")}>
              <CommitInput mono value={node.id} onCommit={rename} />
            </Field>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] text-muted">
                {isEntry ? t("app.inspector.isEntry")
                  : entryOwner ? t("panel.entryOwned", { node: entryOwner.id })
                  : t("app.inspector.notEntry")}
              </span>
              {!isEntry && !entryOwner
                ? <Button size="sm" onClick={() => editor.model.setEntry(node.id)}>{t("panel.makeEntry")}</Button>
                : null}
            </div>
          </Section>
          {group("more").filter((f: any) => f.kind !== "stage-spec").length
            ? <Section>{group("more").filter((f: any) => f.kind !== "stage-spec").map((f: any, i: number) => <div key={i}>{render(f)}</div>)}</Section>
            : null}
        </TabPanel>

        {stageSpec
          ? (
            <TabPanel value="spec" className="min-h-0 flex-1 overflow-y-auto outline-none">
              <Section><StageSpec field={stageSpec} env={env} /></Section>
            </TabPanel>
          )
          : null}
      </Tabs>
    </>
  );
}

function NodesPanel({ editor, ids }: { editor: Editor; ids: string[] }) {
  return (
    <>
      <PanelHead title={tn("panel.selected", ids.length)} onClose={() => editor.selection.clear()} />
      <div className="flex flex-col gap-4 p-4">
        <p className="text-[12.5px] text-muted">{t("panel.selected.about")}</p>
        <div className="flex flex-wrap gap-1.5">
          {ids.map((id) => (
            <button key={id} type="button" onClick={() => editor.selection.set({ type: "node", id })}
              className="h-6 rounded bg-surface-2 px-2 font-mono text-[11.5px] hover:bg-border">
              {id}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => editor.duplicateSelection()}>{t("app.menu.duplicate")}</Button>
          <Button size="sm" variant="danger" onClick={() => editor.deleteSelection()}><Trash2 /> {t("panel.deleteSelected")}</Button>
        </div>
      </div>
    </>
  );
}

function EdgePanel({ editor, from, portIndex }: { editor: Editor; from: string; portIndex: number }) {
  const node = editor.model.node(from);
  const port = node && kindOf(node).orderPorts(node)[portIndex];
  return (
    <>
      <PanelHead title={t("panel.edge")} onClose={() => editor.selection.clear()} />
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-2 font-mono text-[12.5px]">
          <span>{from}</span>
          <span className="rounded bg-surface-2 px-1.5 text-[11px] text-muted">{port?.label ?? "?"}</span>
          <span className="text-subtle">→</span>
          <span>{port?.get?.() ?? "—"}</span>
        </div>
        <div>
          <Button size="sm" variant="danger" onClick={() => editor.deleteSelection()}><Trash2 /> {t("panel.deleteEdge")}</Button>
        </div>
      </div>
    </>
  );
}
