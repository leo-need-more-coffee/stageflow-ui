/**
 * The controls a node's form is made of.
 *
 * The node kinds in the core describe their forms as data (`fields()` in
 * kinds.js): a text field, a list of rows, a stage's arguments by its spec.
 * These components draw those descriptors; they never touch the JSON
 * themselves, only call the descriptor's `get` and `set` and then `touch` the
 * model, which records an undo step and redraws.
 *
 * A text field commits when it is left or on Enter, not on every key, so an
 * undo takes back a word rather than a letter.
 */
import { Braces, CornerDownRight, Hash, Plus, Type, Variable, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { variablesOf } from "@/core/dataflow.js";
import { t } from "@/core/i18n.js";
import {
  argRows, celExpr, celSource, celVarRef, outputRows, writeArgRows, writeOutputRows,
} from "@/core/kinds.js";
import { Arrowed, Button, cn, Input, Label, NativeSelect, Switch } from "@/ui/kit";

import type { Editor } from "../editor";

export interface FieldEnv {
  editor: Editor;
  nodeId: string;
  touch: () => void;
}

/** A catalog label without its own "+ ", for a button that draws a plus icon. */
const plain = (text: string) => text.replace(/^\+\s*/, "");

// ------------------------------------------------------------- primitives

/** An input that keeps its text while typed and hands it over when done. */
export function CommitInput({ value, onCommit, mono, className, ...rest }:
  Omit<React.ComponentProps<typeof Input>, "value" | "onChange"> & {
    value: string;
    onCommit: (value: string) => void;
    mono?: boolean;
  }) {
  const [text, setText] = useState(value);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setText(value);
  }, [value]);
  const commit = () => {
    if (!dirty.current) return;
    dirty.current = false;
    onCommit(text);
  };
  return (
    <Input
      {...rest}
      mono={mono}
      className={className}
      value={text}
      onChange={(e) => { dirty.current = true; setText(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          dirty.current = false;
          setText(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** A variable name, with the graph's variables and the secrets offered. */
export function VarInput({ env, value, onCommit, placeholder, className }:
  { env: FieldEnv; value: string; onCommit: (name: string) => void; placeholder?: string; className?: string }) {
  const list = useId();
  const secrets: string[] = env.editor.secrets?.names() ?? [];
  const names = [...new Set([...variablesOf(env.editor.model.graph), ...secrets])].sort();
  const secret = value && env.editor.secrets?.has(value);
  return (
    <>
      <CommitInput mono list={list} value={value ?? ""} placeholder={placeholder ?? t("field.varName")}
        title={secret ? t("field.secretHint") : undefined}
        className={cn(secret && "text-warn", className)}
        onCommit={(v) => onCommit(v.trim())} />
      <datalist id={list}>
        {names.map((name) => (
          <option key={name} value={name} label={secrets.includes(name) ? t("field.secretOption", { name }) : undefined} />
        ))}
      </datalist>
    </>
  );
}

/** The nodes a link may point at: all but the node itself. */
export function NodeSelect({ env, value, onChange, className }:
  { env: FieldEnv; value: string | null | undefined; onChange: (id: string | null) => void; className?: string }) {
  const ids: string[] = env.editor.model.graph.nodes.map((n: any) => n.id).filter((id: string) => id !== env.nodeId);
  const current = String(value ?? "");
  if (current && !ids.includes(current)) ids.push(current);
  return (
    <NativeSelect mono value={current} className={className}
      onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{t("common.unset")}</option>
      {ids.map((id) => <option key={id} value={id}>{id}</option>)}
    </NativeSelect>
  );
}

export function Field({ label, hint, children, className }:
  { label?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? <Label hint={hint}>{label}</Label> : null}
      {children}
    </div>
  );
}

// ------------------------------------------------- where a value comes from

type Source = "" | "vars" | "const" | "cel";

const SOURCES: { value: Exclude<Source, "">; icon: ReactNode; label: () => string }[] = [
  { value: "vars", icon: <Variable size={13} />, label: () => t("field.source.vars") },
  { value: "const", icon: <Type size={13} />, label: () => t("field.source.const") },
  { value: "cel", icon: <Braces size={13} />, label: () => t("field.source.cel") },
];

/**
 * Where a value comes from: a variable, a literal or an expression. Three
 * small buttons instead of a dropdown, since the choice is made constantly and
 * the current one should be visible without opening anything.
 */
export function SourcePicker({ value, onChange }: { value: Source; onChange: (next: Source) => void }) {
  return (
    <div className="inline-flex shrink-0 rounded-md border border-border bg-surface-2 p-0.5">
      {SOURCES.map((s) => (
        <button key={s.value} type="button" title={s.label()} aria-pressed={value === s.value}
          onClick={() => onChange(value === s.value ? "" : s.value)}
          className={cn("flex h-[26px] w-7 items-center justify-center rounded-[5px] transition-colors",
            value === s.value ? "bg-surface text-fg shadow-card" : "text-subtle hover:text-fg")}>
          {s.icon}
        </button>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- scalars

export function ScalarField({ field, env }: { field: any; env: FieldEnv }) {
  if (field.kind === "check") {
    return (
      <Switch checked={Boolean(field.get())} label={field.label}
        onChange={(v) => { field.set(v); env.touch(); }} />
    );
  }
  if (field.kind === "node-ref") {
    return (
      <Field label={field.label}>
        <NodeSelect env={env} value={field.get()} onChange={(v) => { field.set(v); env.touch(); }} />
      </Field>
    );
  }
  if (field.kind === "select") {
    return (
      <Field label={field.label}>
        <NativeSelect mono value={String(field.get() ?? "")}
          onChange={(e) => { field.set(e.target.value || null); env.touch(); }}>
          {field.options.map((option: any) => {
            const [value, label] = Array.isArray(option) ? option : [option, option];
            return <option key={value} value={value}>{label === "" ? "—" : label}</option>;
          })}
        </NativeSelect>
      </Field>
    );
  }
  return (
    <Field label={field.label}>
      <CommitInput mono={field.kind === "cel"} type={field.kind === "number" ? "number" : "text"}
        value={String(field.get() ?? "")} placeholder={field.placeholder}
        onCommit={(v) => { field.set(v.trim() || null); env.touch(); }} />
    </Field>
  );
}

/** A CEL field filled in like an argument: a variable, a value or an expression. */
export function ValueField({ field, env, modes }:
  { field: any; env: FieldEnv; modes: Map<string, Source> }) {
  const key = `${env.nodeId}|${field.label}`;
  const text = String(field.get() ?? "");
  const read = celSource(text);
  const chosen = modes.get(key);
  // the text decides the source, except while an expression is being typed:
  // `vars.count` on the way to `vars.count > 0` looks like a variable
  const source: Source = text.trim()
    ? (chosen && (chosen === "cel" || chosen === read.source) ? chosen : read.source)
    : chosen ?? "";
  const value = source === read.source ? read.value : text;
  const write = (mode: Source, next: string) => {
    modes.set(key, mode);
    field.set((mode === "vars" && field.varName
      ? celVarRef(String(next ?? "").trim() || field.varName)
      : celExpr(mode, next)) || null);
    env.touch();
  };
  return (
    <Field label={field.label}>
      <div className="flex gap-1.5">
        <SourcePicker value={source} onChange={(next) => {
          if (!next) {
            modes.delete(key);
            field.set(null);
            env.touch();
            return;
          }
          write(next, next === "cel" ? text : "");
        }} />
        {!source
          ? <div className="flex h-8 flex-1 items-center text-[12px] text-subtle">{t("app.field.pickSource")}</div>
          : source === "vars"
            ? <VarInput env={env} value={value} onCommit={(name) => write("vars", name)} className="flex-1" />
            : <CommitInput mono={source === "cel"} className="flex-1" value={value}
                placeholder={source === "cel" ? field.placeholder ?? t("args.celPlaceholder") : field.valuePlaceholder ?? t("field.valueOrJson")}
                onCommit={(v) => write(source, v)} />}
      </div>
    </Field>
  );
}

export function TagsField({ field, env }: { field: any; env: FieldEnv }) {
  const values: string[] = field.get();
  const [text, setText] = useState("");
  const add = () => {
    const value = text.trim();
    setText("");
    if (!value || values.includes(value)) return;
    field.set([...values, value]);
    env.touch();
  };
  return (
    <Field label={field.label}>
      <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-1 focus-within:border-accent">
        {values.map((value) => (
          <span key={value} className="inline-flex h-6 items-center gap-1 rounded bg-surface-2 pl-2 pr-1 font-mono text-[11.5px]">
            {value}
            <button type="button" className="text-subtle hover:text-fg"
              onClick={() => { field.set(values.filter((v) => v !== value)); env.touch(); }}>
              <X size={12} />
            </button>
          </span>
        ))}
        <input value={text} onChange={(e) => setText(e.target.value)} onBlur={add}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          placeholder={values.length ? "" : t("app.field.tagHint")}
          className="h-6 min-w-[80px] flex-1 bg-transparent px-1 font-mono text-[12px] outline-none placeholder:font-sans placeholder:text-subtle" />
      </div>
    </Field>
  );
}

// -------------------------------------------------------------------- rows

/**
 * A table of rows: cases, branches, retries, outputs. A row that cannot be
 * stored yet (no target picked) is kept here as a draft, otherwise "add a
 * row" would vanish on the next redraw.
 */
export function RowsField({ field, env, drafts }:
  { field: any; env: FieldEnv; drafts: Map<string, any[]> }) {
  const key = `${env.nodeId}|${field.label}`;
  const incomplete = field.incomplete ?? (() => false);
  const saved = field.get();
  const pending = (drafts.get(key) ?? []).filter(incomplete);
  const rows = [...saved, ...pending];
  const commit = () => {
    const waiting = rows.filter(incomplete);
    if (waiting.length) drafts.set(key, waiting);
    else drafts.delete(key);
    field.set(rows.filter((row: any) => !incomplete(row)));
    env.touch();
  };

  return (
    <Field label={field.label}>
      <div className="flex flex-col gap-1.5">
        {rows.map((row: any, index: number) => (
          <div key={index} className={cn("flex items-center gap-1.5", incomplete(row) && "opacity-70")}>
            {field.columns.map((col: any) => (
              <RowCell key={col.key} col={col} row={row} env={env} commit={commit} />
            ))}
            <Button variant="ghost" size="icon-sm" aria-label={t("app.field.removeRow")}
              onClick={() => { rows.splice(index, 1); commit(); }}>
              <X />
            </Button>
          </div>
        ))}
        <div>
          <Button variant="ghost" size="sm" className="-ml-2"
            onClick={() => { rows.push(field.blank()); commit(); }}>
            <Plus /> {t("app.field.addRow")}
          </Button>
        </div>
      </div>
    </Field>
  );
}

function RowCell({ col, row, env, commit }: { col: any; row: any; env: FieldEnv; commit: () => void }) {
  const style = col.width ? { flex: `0 1 ${col.width}`, minWidth: 0 } : { flex: "1 1 0", minWidth: 0 };
  const list = useId();
  if (col.type === "label") {
    return <span className="flex shrink-0 justify-center text-subtle" style={{ width: col.width }}><Arrowed text={col.text} /></span>;
  }
  if (col.type === "select" && col.key === "source" && col.options?.length === 3) {
    // the three sources: the same buttons as everywhere else
    return (
      <SourcePicker value={row[col.key] ?? ""} onChange={(next) => { if (!next) return; row[col.key] = next; commit(); }} />
    );
  }
  if (col.type === "select" && col.options?.length === 2 && col.options.some((o: any) => (Array.isArray(o) ? o[0] : o) === "cel")) {
    // a field of the answer, or an expression: the same buttons as a source
    const [field] = col.options.map((o: any) => (Array.isArray(o) ? o[0] : o)).filter((v: string) => v !== "cel");
    const current = row[col.key] === "cel" ? "cel" : field;
    const choices = [
      { value: field, icon: <Hash size={13} />, title: String(col.options.find((o: any) => (Array.isArray(o) ? o[0] : o) === field)?.[1] ?? field) },
      { value: "cel", icon: <Braces size={13} />, title: t("field.source.cel") },
    ];
    return (
      <div className="inline-flex shrink-0 rounded-md border border-border bg-surface-2 p-0.5" title={col.title}>
        {choices.map((c) => (
          <button key={c.value} type="button" title={c.title} aria-pressed={current === c.value}
            onClick={() => { row[col.key] = c.value; commit(); }}
            className={cn("flex h-[26px] w-7 items-center justify-center rounded-[5px] transition-colors",
              current === c.value ? "bg-surface text-fg shadow-card" : "text-subtle hover:text-fg")}>
            {c.icon}
          </button>
        ))}
      </div>
    );
  }
  if (col.type === "node-ref") {
    return (
      <div style={style}>
        <NodeSelect env={env} value={row[col.key]} onChange={(v) => { row[col.key] = v ?? ""; commit(); }} />
      </div>
    );
  }
  if (col.type === "select") {
    return (
      <div style={style}>
        <NativeSelect mono value={String(row[col.key] ?? "")} title={col.title}
          onChange={(e) => { row[col.key] = col.asBool ? e.target.value === "true" : e.target.value; commit(); }}>
          {col.options.map((option: any) => {
            const [value, label] = Array.isArray(option) ? option : [option, option];
            return <option key={String(value)} value={value}>{label === "" ? "—" : label}</option>;
          })}
        </NativeSelect>
      </div>
    );
  }
  return (
    <div style={style}>
      <CommitInput mono type={col.type === "number" ? "number" : "text"} value={String(row[col.key] ?? "")}
        placeholder={col.placeholder} title={col.title} list={col.suggestions?.length ? list : undefined}
        onCommit={(v) => { row[col.key] = v; commit(); }} />
      {col.suggestions?.length
        ? <datalist id={list}>{col.suggestions.map((s: string) => <option key={s} value={s} />)}</datalist>
        : null}
    </div>
  );
}

// --------------------------------------------- a stage's inputs and outputs

function TypeChip({ type }: { type?: string }) {
  if (!type) return null;
  return <span className="rounded bg-surface-2 px-1.5 py-px font-mono text-[10.5px] text-muted">{type}</span>;
}

/**
 * A stage's inputs: one row per argument its spec declares, with type,
 * description and whether it is required. Keys the spec does not declare are
 * listed under it, not dropped.
 */
export function SpecArgs({ field, env }: { field: any; env: FieldEnv }) {
  const { node, spec } = field;
  const declared = (spec?.arguments ?? []).filter((a: any) => a.name !== "*");
  const rows = argRows(node);
  const byName = new Map(rows.map((r: any) => [r.name, r]));
  const acceptsExtra = (spec?.arguments ?? []).some((a: any) => a.name === "*");
  const extra = rows.filter((r: any) => !declared.some((a: any) => a.name === r.name));
  const [adding, setAdding] = useState(false);
  const write = (name: string, row: any) => {
    const next = argRows(node).filter((r: any) => r.name !== name);
    if (row) next.push({ name, ...row });
    writeArgRows(node, next);
    env.touch();
  };

  return (
    <div className="flex flex-col gap-3">
      {declared.map((arg: any) => <ArgRow key={arg.name} arg={arg} row={byName.get(arg.name)} write={write} env={env} />)}
      {extra.length && declared.length
        ? <div className="text-[11.5px] text-subtle">{t(acceptsExtra ? "args.extra.ok" : "args.extra.unknown")}</div>
        : null}
      {extra.map((row: any) => (
        <ArgRow key={row.name} removable env={env} write={write} row={row}
          arg={{ name: row.name, description: t(acceptsExtra ? "args.extra.ok.hint" : "args.extra.unknown.hint") }} />
      ))}
      {!declared.length && !extra.length
        ? <div className="text-[12px] text-subtle">{t(spec ? "args.none" : "args.noSpec")}</div>
        : null}
      {adding
        ? (
          <CommitInput mono autoFocus value="" placeholder={t("accept.argumentPrompt")}
            onCommit={(name) => { setAdding(false); if (name.trim()) write(name.trim(), { source: "vars", value: "" }); }}
            onBlur={() => setAdding(false)} />
        )
        : (
          <div>
            <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setAdding(true)}>
              <Plus /> {plain(t("args.addOwn"))}
            </Button>
          </div>
        )}
    </div>
  );
}

function ArgRow({ arg, row, write, env, removable = false }:
  { arg: any; row: any; write: (name: string, row: any) => void; env: FieldEnv; removable?: boolean }) {
  const required = arg.optional === false;
  const mode: Source = !row ? "" : row.source === "const" ? "const" : row.source === "cel" ? "cel" : "vars";
  return (
    <div className={cn("flex flex-col gap-1.5", required && !row && "rounded-md bg-bad/5 -mx-2 px-2 py-1.5")}>
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[12px] font-medium text-fg">{arg.name}</span>
        {required ? <span className="text-bad" title={t("args.required")}>*</span> : null}
        <TypeChip type={arg.type} />
        {arg.optional ? <span className="text-[11px] text-subtle">{t("args.optional")}</span> : null}
        <span className="flex-1" />
        {removable
          ? <Button variant="ghost" size="icon-sm" title={t("args.remove")} onClick={() => write(arg.name, null)}><X /></Button>
          : null}
      </div>
      {arg.description ? <div className="-mt-0.5 text-[11.5px] leading-snug text-muted">{arg.description}</div> : null}
      <div className="flex gap-1.5">
        <SourcePicker value={mode} onChange={(next) => {
          if (!next) return write(arg.name, null);
          write(arg.name, { source: next, value: next === mode ? row?.value ?? "" : "" });
        }} />
        {mode === "vars"
          ? <VarInput env={env} className="flex-1" value={row.value} onCommit={(value) => write(arg.name, { source: "vars", value })} />
          : mode === "const"
            ? <ConstInput arg={arg} row={row} onSet={(value) => write(arg.name, { source: "const", value })} />
            : mode === "cel"
              ? <CommitInput mono className="flex-1" value={row.value ?? ""} placeholder={t("args.celPlaceholder")}
                  onCommit={(value) => write(arg.name, { source: row.source, value })} />
              : <div className="flex h-8 flex-1 items-center text-[12px] text-subtle">{t("app.field.pickSource")}</div>}
      </div>
    </div>
  );
}

function ConstInput({ arg, row, onSet }: { arg: any; row: any; onSet: (value: string) => void }) {
  const type = String(arg.type ?? "any").toLowerCase();
  if (type === "bool" || type === "boolean") {
    return (
      <div className="flex h-8 flex-1 items-center">
        <Switch checked={row.value === true || row.value === "true"} onChange={(v) => onSet(String(v))}
          label={<span className="text-[12px] text-muted">{t("field.yesNo")}</span>} />
      </div>
    );
  }
  const numeric = ["number", "int", "float"].includes(type);
  return (
    <CommitInput mono className="flex-1" type={numeric ? "number" : "text"} value={String(row.value ?? "")}
      placeholder={type === "list" ? '["a", "b"]' : type === "object" ? '{"k": 1}' : t("field.valueOrJson")}
      onCommit={onSet} />
  );
}

/**
 * A stage's outputs: a switch per declared result field, and the variable it
 * is kept in. A field not kept stays listed, so what is thrown away is seen.
 */
export function SpecOutputs({ field, env }: { field: any; env: FieldEnv }) {
  const { node, spec } = field;
  const declared = spec?.outputs ?? [];
  const rows = outputRows(node);
  const known = declared.map((o: any) => o.name);
  const contractKnown = known.length && !known.includes("*");
  const [adding, setAdding] = useState(false);
  const write = (src: string, row: any) => {
    const next = outputRows(node).filter((r: any) => r.cel || r.src !== src);
    if (row) next.push({ src, cel: false, ...row });
    writeOutputRows(node, next);
    env.touch();
  };
  const writeAt = (index: number, patch: any) => {
    const next = outputRows(node);
    if (patch) next[index] = { ...next[index], ...patch };
    else next.splice(index, 1);
    writeOutputRows(node, next);
    env.touch();
  };
  const extra = rows.map((row: any, index: number) => ({ row, index }))
    .filter(({ row }: any) => row.cel || !declared.some((o: any) => o.name === row.src));

  return (
    <div className="flex flex-col gap-3">
      {declared.map((out: any) => {
        const row = rows.find((r: any) => !r.cel && r.src === out.name);
        return (
          <div key={out.name} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Switch checked={Boolean(row)} onChange={(on) => write(out.name, on ? { dest: out.name } : null)}
                label={<span className={cn("font-mono text-[12px] font-medium", row ? "text-fg" : "text-muted")}>{out.name}</span>} />
              <TypeChip type={out.type} />
              {!row ? <span className="text-[11px] text-subtle">{t("outs.notSaved")}</span> : null}
            </div>
            {out.description ? <div className="-mt-0.5 pl-10 text-[11.5px] leading-snug text-muted">{out.description}</div> : null}
            {row
              ? (
                <div className="flex items-center gap-2 pl-10" title={t("app.field.into")}>
                  <CornerDownRight size={14} className="shrink-0 text-subtle" />
                  <VarInput env={env} className="flex-1" value={row.dest} onCommit={(dest) => write(out.name, { dest })} />
                </div>
              )
              : null}
          </div>
        );
      })}
      {extra.map(({ row, index }: any) => {
        const unknownField = !row.cel && known.length && !known.includes(row.src) && !known.includes("*");
        return (
          <div key={`x${index}`} className={cn("flex flex-col gap-1.5", unknownField && "rounded-md bg-bad/5 -mx-2 px-2 py-1.5")}>
            <div className="flex items-center gap-1.5">
              <span className="text-subtle">{row.cel ? <Braces size={13} /> : <Hash size={13} />}</span>
              <CommitInput mono className="flex-1" value={row.src ?? ""}
                placeholder={t(row.cel ? "outs.exprPlaceholder" : "outs.fieldPlaceholder")}
                onCommit={(src) => writeAt(index, { src: src.trim() })} />
              <Button variant="ghost" size="icon-sm" title={t("outs.remove")} onClick={() => writeAt(index, null)}><X /></Button>
            </div>
            {unknownField
              ? <div className="text-[11.5px] text-bad">{t("outs.unknownField", { available: known.join(", ") })}</div>
              : row.cel && !row.src ? <div className="text-[11.5px] text-subtle">{t("outs.exprEmpty")}</div> : null}
            <div className="flex items-center gap-2 pl-5" title={t("app.field.into")}>
              <CornerDownRight size={14} className="shrink-0 text-subtle" />
              <VarInput env={env} className="flex-1" value={row.dest} onCommit={(dest) => writeAt(index, { dest })} />
            </div>
          </div>
        );
      })}
      {!declared.length && !extra.length
        ? <div className="text-[12px] text-subtle">{t(spec ? "outs.none" : "args.noSpec")}</div>
        : null}
      {adding
        ? (
          <CommitInput mono autoFocus value="" placeholder={t(contractKnown ? "outs.addExpr.prompt" : "outs.addField.prompt")}
            onBlur={() => setAdding(false)}
            onCommit={(name) => {
              setAdding(false);
              const clean = name.trim();
              if (!clean) return;
              if (contractKnown) writeAt(outputRows(node).length, { cel: true, src: "", dest: clean });
              else write(clean, { dest: clean });
            }} />
        )
        : (
          <div>
            <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setAdding(true)}>
              <Plus /> {plain(t(contractKnown ? "outs.addExpr" : "outs.addField"))}
            </Button>
          </div>
        )}
    </div>
  );
}

/** The stage's reference from the backend's specs. */
export function StageSpec({ field, env }: { field: any; env: FieldEnv }) {
  const spec = env.editor.stages.get(field.stage());
  if (!spec) {
    return <div className="text-[12px] text-subtle">{t(env.editor.stages.loaded ? "spec.unknownStage" : "spec.notLoaded")}</div>;
  }
  return (
    <div className="flex flex-col gap-3 text-[12px]">
      {spec.description ? <p className="text-muted">{spec.description}</p> : null}
      {(["arguments", "outputs"] as const).map((section) => {
        const list = spec[section] ?? [];
        if (!list.length) return null;
        return (
          <div key={section}>
            <div className="mb-1 text-[11px] font-medium text-subtle">{t(`spec.${section}`)}</div>
            <div className="flex flex-col gap-1">
              {list.map((f: any) => (
                <div key={f.name} className="flex gap-2">
                  <code className="font-mono text-fg">{f.name}</code>
                  <span className="text-muted">{f.type}{f.optional ? ` ${t("spec.opt")}` : ""}{f.description ? ` — ${f.description}` : ""}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
