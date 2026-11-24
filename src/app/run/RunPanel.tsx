/**
 * The run, at the bottom of the window while there is one.
 *
 * A run is read as a list of steps, one per node it went through, not as a
 * log: pick a step and see the variables as that node left them, with what
 * it changed marked, and the events it sent. The last step is followed while
 * the run goes on; picking an earlier one holds it there.
 *
 * A run saved at a `wait` node is answered from here, with a form built from
 * what the node reads out of the answer.
 */
import {
  Check, ChevronDown, ChevronUp, Hourglass, Loader2, Pause, RotateCcw, Send, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { t } from "@/core/i18n.js";
import { formatLiteral, outputRows, parseLiteral } from "@/core/kinds.js";
import { SECRET_MASK } from "@/core/secrets.js";
import { Badge, Button, cn, Input, Segmented, Textarea, Tip } from "@/ui/kit";

import { useEditor } from "../context";
import type { Editor } from "../editor";
import { KindIcon } from "../kindIcon";

interface Step {
  node: string;
  before: Record<string, unknown>;
  after: Record<string, unknown> | null;
  events: any[];
  state: "running" | "done" | "failed" | "awaiting" | "paused";
}

/** The steps of a run, from its events. */
function stepsOf(log: any[], status: string): Step[] {
  const steps: Step[] = [];
  let frame: Record<string, unknown> = {};
  for (const event of log) {
    if (event.type === "node_enter") {
      const last = steps[steps.length - 1];
      if (last && last.state === "running") last.state = "done";
      frame = event.vars ?? frame;
      steps.push({ node: event.node, before: frame, after: null, events: [event], state: "running" });
      continue;
    }
    const step = steps[steps.length - 1];
    if (!step) continue;
    if (event.vars) frame = event.vars;
    step.events.push(event);
    if (event.type === "node_exit") {
      step.after = event.vars ?? frame;
      step.state = "done";
    } else if (event.type === "failed") {
      step.state = "failed";
    } else if (event.type === "waiting") {
      step.state = "awaiting";
    } else if (event.type === "var_set" || event.type === "var_dropped") {
      step.after = frame;
    }
  }
  const last = steps[steps.length - 1];
  if (last && last.state === "running") {
    if (status === "paused") last.state = "paused";
    else if (status === "finished" || status === "stopped") last.state = "done";
    else if (status === "failed") last.state = "failed";
    else if (status === "awaiting") last.state = "awaiting";
  }
  return steps;
}

const HEIGHT_KEY = "stageflow-editor:run-panel";

function readHeight() {
  try {
    const value = Number(localStorage.getItem(HEIGHT_KEY));
    return value >= 160 ? value : 300;
  } catch {
    return 300;
  }
}

export function RunPanel() {
  const editor = useEditor();
  const runner = editor.runner;
  const [height, setHeight] = useState(readHeight);
  const [collapsed, setCollapsed] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const steps = useMemo(() => stepsOf(runner.log, runner.status), [runner.log.length, runner.status, editor.version]);
  const runKey = runner.runId;

  // a new run follows its last step again
  useEffect(() => setPicked(null), [runKey]);

  if (runner.status === "idle") return null;

  const index = picked ?? steps.length - 1;
  const step = steps[index] ?? null;
  const following = picked === null;

  const startResize = (e: React.PointerEvent) => {
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent) => setHeight(Math.max(160, Math.min(window.innerHeight * 0.75, startH + startY - ev.clientY)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try { localStorage.setItem(HEIGHT_KEY, String(Math.round(height))); } catch { /* not remembered */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section className="relative flex shrink-0 flex-col border-t border-border bg-surface" style={{ height: collapsed ? 44 : height }}>
      {!collapsed ? <div className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize" onPointerDown={startResize} /> : null}
      <RunHead editor={editor} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      {collapsed
        ? null
        : (
          <>
            {runner.awaitingInput && runner.awaiting ? <AnswerForm editor={editor} /> : null}
            <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)_minmax(0,1fr)]">
              <StepList editor={editor} steps={steps} index={index} following={following}
                onPick={(i) => setPicked(i === steps.length - 1 ? null : i)} />
              <FramePane editor={editor} step={step} live={following && runner.active} />
              <EventsPane editor={editor} step={step} />
            </div>
          </>
        )}
    </section>
  );
}

// ------------------------------------------------------------------- head

function Meters({ editor }: { editor: Editor }) {
  const { meters = {}, meterLimits = {} } = editor.runner;
  const names = Object.keys(meters)
    .filter((name) => !name.startsWith("peak_") || name in meterLimits)
    .sort((a, b) => Number(b in meterLimits) - Number(a in meterLimits) || a.localeCompare(b));
  return (
    <div className="flex items-center gap-3">
      {names.map((name) => {
        const spent = meters[name];
        const limit = meterLimits[name];
        const shown = Number.isInteger(spent) ? spent : Number(spent).toFixed(2);
        const share = limit === undefined ? 0 : limit > 0 ? spent / limit : 1;
        return (
          <Tip key={name} content={limit === undefined ? t("debug.meterFree", { name, spent: shown }) : t("debug.meterLimited", { name, spent: shown, limit })}>
            <div className="flex items-center gap-1.5 text-[11.5px]">
              <span className="text-subtle">{name}</span>
              <span className={cn("font-mono tabular-nums", share >= 1 ? "text-bad" : share >= 0.8 ? "text-warn" : "text-fg")}>
                {limit === undefined ? shown : `${shown}/${limit}`}
              </span>
              {limit !== undefined
                ? (
                  <span className="h-1 w-10 overflow-hidden rounded-full bg-surface-2">
                    <span className={cn("block h-full rounded-full", share >= 1 ? "bg-bad" : share >= 0.8 ? "bg-warn" : "bg-accent")}
                      style={{ width: `${Math.min(100, share * 100)}%` }} />
                  </span>
                )
                : null}
            </div>
          </Tip>
        );
      })}
    </div>
  );
}

function RunHead({ editor, collapsed, onToggle }: { editor: Editor; collapsed: boolean; onToggle: () => void }) {
  const runner = editor.runner;
  const tone: any = { running: "accent", paused: "warn", awaiting: "warn", finished: "ok", stopped: "neutral", failed: "bad" }[runner.status as string] ?? "neutral";
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
      <Badge tone={tone}>
        {runner.status === "running" ? <Loader2 size={11} className="animate-spin" /> : null}
        {runner.status === "paused" ? <Pause size={11} /> : null}
        {runner.status === "awaiting" ? <Hourglass size={11} /> : null}
        {runner.status === "finished" ? <Check size={11} /> : null}
        {t(runner.status === "paused" ? "debug.paused" : runner.status === "awaiting" ? "debug.awaiting" : `status.${runner.status}`)}
      </Badge>
      {runner.node
        ? (
          <button type="button" className="font-mono text-[12px] text-muted hover:text-fg"
            onClick={() => editor.reveal({ graph: null, node: runner.node, message: "" })}>
            {runner.node}
          </button>
        )
        : null}
      {runner.error ? <span className="min-w-0 truncate text-[12px] text-bad" title={runner.error}>{runner.error}</span> : null}
      {runner.status === "finished" && runner.artifacts
        ? <span className="truncate text-[12px] text-muted">{Object.keys(runner.artifacts).length ? t("debug.artifacts", { names: Object.keys(runner.artifacts).join(", ") }) : t("debug.noArtifacts")}</span>
        : null}
      <div className="flex-1" />
      <Meters editor={editor} />
      {runner.active
        ? (
          <Segmented size="sm" value={String(editor.runDelay)} onChange={(v) => editor.setRunDelay(Number(v))}
            options={[0, 0.25, 0.5, 1].map((v) => ({ value: String(v), label: v ? `${v}s` : "0", title: t("debug.delayHint") }))} />
        )
        : null}
      {!runner.active && !runner.awaitingInput
        ? (
          <Button size="sm" variant="ghost" onClick={() => void editor.run({ mode: runner.mode, ask: false })}>
            <RotateCcw /> {t("debug.rerun")}
          </Button>
        )
        : null}
      <Button variant="ghost" size="icon-sm" onClick={onToggle} aria-label={t("app.run.fold")}>
        {collapsed ? <ChevronUp /> : <ChevronDown />}
      </Button>
      {!runner.active && !runner.awaitingInput
        ? <Button variant="ghost" size="icon-sm" onClick={() => runner.reset()} aria-label={t("debug.close")}><X /></Button>
        : null}
    </div>
  );
}

// ------------------------------------------------------------------ steps

function StepIcon({ state }: { state: Step["state"] }) {
  if (state === "running") return <Loader2 size={13} className="animate-spin text-accent" />;
  if (state === "failed") return <X size={13} className="text-bad" strokeWidth={3} />;
  if (state === "awaiting") return <Hourglass size={13} className="text-warn" />;
  if (state === "paused") return <Pause size={13} className="text-warn" />;
  return <Check size={13} className="text-ok" strokeWidth={3} />;
}

function StepList({ editor, steps, index, following, onPick }:
  { editor: Editor; steps: Step[]; index: number; following: boolean; onPick: (i: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (following && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [steps.length, following]);
  const typeOf = (id: string) => editor.model.pipeline.nodes.find((n: any) => n.id === id)?.type ?? "stage";
  return (
    <div className="flex min-h-0 flex-col border-r border-border">
      <PaneTitle>{t("app.run.steps")} <span className="text-subtle">{steps.length}</span></PaneTitle>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {!steps.length ? <div className="px-2 py-3 text-[12px] text-subtle">{t(editor.runner.active ? "app.run.noSteps" : "app.run.noStepsEnded")}</div> : null}
        {steps.map((step, i) => (
          <button key={i} type="button" onClick={() => onPick(i)}
            onDoubleClick={() => editor.reveal({ graph: null, node: step.node, message: "" })}
            className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left",
              i === index ? "bg-surface-2" : "hover:bg-surface-2/60")}>
            <span className="w-5 text-right font-mono text-[10.5px] text-subtle tabular-nums">{i + 1}</span>
            <KindIcon type={typeOf(step.node)} size={18} />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{step.node}</span>
            <StepIcon state={step.state} />
          </button>
        ))}
      </div>
    </div>
  );
}

function PaneTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-[12px] font-medium text-muted">
      <span className="flex items-center gap-1.5">{children}</span>
      <span className="flex-1" />
      {aside}
    </div>
  );
}

// ------------------------------------------------------------------ frame

/**
 * The variables as the step left them. What the step added or changed is
 * marked; while the run stands on its last step, values can be edited.
 */
function FramePane({ editor, step, live }: { editor: Editor; step: Step | null; live: boolean }) {
  const runner = editor.runner;
  const frame: Record<string, unknown> = live || !step ? runner.vars : step.after ?? step.before;
  const before = step?.before ?? {};
  const names = Object.keys(frame).sort();
  const dropped = step ? Object.keys(before).filter((name) => !(name in frame)) : [];
  const [onlyChanged, setOnlyChanged] = useState(false);
  const changed = (name: string) => !(name in before) ? "added"
    : JSON.stringify(before[name]) !== JSON.stringify(frame[name]) ? "changed" : null;
  const shown = onlyChanged ? names.filter((n) => changed(n)) : names;
  const editable = live && runner.active;

  return (
    <div className="flex min-h-0 flex-col border-r border-border">
      <PaneTitle aside={step
        ? (
          <Segmented size="sm" value={onlyChanged ? "changed" : "all"} onChange={(v) => setOnlyChanged(v === "changed")}
            options={[{ value: "all", label: t("app.run.allVars") }, { value: "changed", label: t("app.run.changedVars") }]} />
        )
        : null}>
        {t("debug.vars")}
        {step ? <span className="font-mono normal-case tracking-normal text-subtle">· {step.node}</span> : null}
      </PaneTitle>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {!shown.length && !dropped.length
          ? <div className="py-2 text-[12px] text-subtle">{onlyChanged ? t("app.run.nothingChanged") : t("debug.emptyFrame")}</div>
          : null}
        <div className="grid grid-cols-[minmax(80px,max-content)_1fr] gap-x-3">
          {shown.map((name) => {
            const secret = editor.secrets?.has(name) ?? false;
            const mark = step ? changed(name) : null;
            return (
              <VarRow key={name} name={name} mark={mark} secret={secret} editable={editable && !secret}
                value={secret ? SECRET_MASK : formatLiteral(frame[name])}
                onSet={(v) => void runner.setVar(name, parseLiteral(v))}
                onDrop={editable ? () => void runner.dropVar(name) : undefined} />
            );
          })}
          {dropped.map((name) => (
            <VarRow key={`-${name}`} name={name} mark="dropped" value={formatLiteral(before[name])} />
          ))}
        </div>
        {editable ? <AddVar editor={editor} /> : null}
      </div>
    </div>
  );
}

function VarRow({ name, value, mark, secret, editable, onSet, onDrop }: {
  name: string; value: string; mark: "added" | "changed" | "dropped" | null;
  secret?: boolean; editable?: boolean; onSet?: (v: string) => void; onDrop?: () => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const color = mark === "added" ? "text-ok" : mark === "changed" ? "text-warn" : mark === "dropped" ? "text-subtle line-through" : "text-muted";
  return (
    <>
      <div className={cn("flex h-7 items-center gap-1.5 font-mono text-[12px]", color)}>
        {mark ? <span className={cn("size-1.5 rounded-full", mark === "added" ? "bg-ok" : mark === "changed" ? "bg-warn" : "bg-subtle")} /> : null}
        <span className="truncate">{name}</span>
      </div>
      <div className="group flex min-w-0 items-center gap-1">
        {editable
          ? (
            <input value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
              onBlur={() => { if (text !== value) onSet?.(text); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              className="h-7 min-w-0 flex-1 truncate rounded border border-transparent bg-transparent px-1.5 font-mono text-[12px] text-fg outline-none hover:border-border focus:border-accent" />
          )
          : (
            <span className={cn("h-7 min-w-0 flex-1 truncate px-1.5 font-mono text-[12px] leading-7", secret ? "text-warn" : "text-fg", mark === "dropped" && "text-subtle line-through")}
              title={value}>
              {value}
            </span>
          )}
        {onDrop
          ? <button type="button" className="text-subtle opacity-0 hover:text-fg group-hover:opacity-100" title={t("debug.dropVar")} onClick={onDrop}><X size={13} /></button>
          : null}
      </div>
    </>
  );
}

function AddVar({ editor }: { editor: Editor }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const add = () => {
    if (!name.trim()) return;
    void editor.runner.setVar(name.trim(), parseLiteral(value));
    setName("");
    setValue("");
  };
  return (
    <div className="mt-2 flex gap-1.5">
      <Input mono className="h-7 w-[140px] text-[12px]" placeholder={t("debug.varName")} value={name} onChange={(e) => setName(e.target.value)} />
      <Input mono className="h-7 flex-1 text-[12px]" placeholder={t("field.result.value")} value={value} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
      <Button size="sm" onClick={add}>{t("debug.addVar")}</Button>
    </div>
  );
}

// ----------------------------------------------------------------- events

function detail(editor: Editor, event: any): string {
  if (event.type === "var_set" && editor.secrets?.has(event.name)) return `${event.name} = ${SECRET_MASK}`;
  if (event.type === "var_set") return `${event.name} = ${formatLiteral(event.value)}`;
  if (event.type === "var_rejected") return `${event.name}: ${event.error}`;
  if (event.type === "var_dropped") return event.name;
  if (event.type === "failed") return event.error;
  if (event.type === "finished") return event.status;
  const payload = event.payload ?? {};
  const keys = Object.keys(payload);
  if (!keys.length) return "";
  return keys.map((key) => `${key}: ${formatLiteral(payload[key])}`).join(", ");
}

function EventsPane({ editor, step }: { editor: Editor; step: Step | null }) {
  const runner = editor.runner;
  const stream = step ? runner.streams.get(step.node) : null;
  const [tab, setTab] = useState<"events" | "output">("events");
  const showing = stream && tab === "output" ? "output" : "events";
  const events = (step?.events ?? []).filter((e) => e.type !== "node_enter" && e.type !== "node_exit");
  return (
    <div className="flex min-h-0 flex-col">
      <PaneTitle aside={stream
        ? (
          <Segmented size="sm" value={showing} onChange={setTab}
            options={[{ value: "events", label: t("debug.events") }, { value: "output", label: runner.streamLabel || t("debug.stream") }]} />
        )
        : null}>
        {t("debug.events")}
      </PaneTitle>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {showing === "output"
          ? <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-fg">{stream}</pre>
          : (
            <>
              {!events.length ? <div className="py-2 text-[12px] text-subtle">{t("app.run.noEvents")}</div> : null}
              {events.map((event, i) => (
                <div key={i} className="flex gap-3 border-b border-border/60 py-1.5 last:border-b-0">
                  <span className={cn("w-[150px] shrink-0 truncate font-mono text-[11.5px]",
                    event.type === "failed" ? "text-bad" : event.type === "waiting" || event.type === "waiting_started" ? "text-warn" : "text-muted")}>
                    {event.type}
                  </span>
                  <span className="min-w-0 break-words font-mono text-[11.5px] text-fg">{detail(editor, event)}</span>
                </div>
              ))}
            </>
          )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- answer

/** `{field: ""}` for every field the wait node reads from its answer. */
function answerFields(editor: Editor, nodeId: string): string[] {
  const node = editor.model.pipeline.nodes.find((n: any) => n.id === nodeId);
  const fields: string[] = [];
  for (const row of node ? outputRows(node) : []) {
    if (!row.cel && !fields.includes(row.src)) fields.push(row.src);
    for (const match of row.cel ? String(row.src).matchAll(/output\.([^\W\d]\w*)/gu) : []) {
      if (!fields.includes(match[1])) fields.push(match[1]);
    }
  }
  return fields;
}

function AnswerForm({ editor }: { editor: Editor }) {
  const runner = editor.runner;
  const wait = runner.awaiting!;
  const fields = answerFields(editor, wait.node);
  const [mode, setMode] = useState<"form" | "json">(fields.length ? "form" : "json");
  const [values, setValues] = useState<Record<string, string>>({});
  const [json, setJson] = useState(() => JSON.stringify(Object.fromEntries(fields.map((f) => [f, ""])), null, 2));
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    let payload: unknown;
    if (mode === "form") {
      payload = Object.fromEntries(fields.filter((f) => values[f]?.trim()).map((f) => [f, parseLiteral(values[f])]));
    } else {
      try {
        payload = JSON.parse(json || "{}");
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error(t("debug.answerObject"));
      } catch (err: any) {
        setError(err.message);
        return;
      }
    }
    setError("");
    setSending(true);
    try {
      await runner.answer(payload);
    } catch (err: any) {
      setError(err.message);
      setSending(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-col gap-3 border-b border-border bg-warn/5 px-4 py-3">
      <div className="flex items-center gap-3">
        <Hourglass size={15} className="text-warn" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{t("app.answer.title", { input: wait.input, node: wait.node })}</div>
          <div className="text-[12px] text-muted">
            {wait.deadline
              ? t("app.answer.deadline", { time: new Date(wait.deadline * 1000).toLocaleString() })
              : t("app.answer.noDeadline")}
          </div>
        </div>
        <Segmented size="sm" value={mode} onChange={setMode}
          options={[{ value: "form", label: t("app.answer.form") }, { value: "json", label: "JSON" }]} />
      </div>
      <form className="flex max-w-[747px] flex-col gap-2 pl-[27px]" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        {mode === "form"
          ? (
            <div className="grid grid-cols-[minmax(80px,max-content)_1fr] items-center gap-x-3 gap-y-1.5">
              {fields.map((field, i) => (
                <FieldRow key={field} name={field}>
                  <Input mono autoFocus={i === 0} value={values[field] ?? ""} placeholder={t("app.answer.empty")}
                    onChange={(e) => setValues({ ...values, [field]: e.target.value })} />
                </FieldRow>
              ))}
            </div>
          )
          : <Textarea mono rows={Math.min(8, Math.max(3, json.split("\n").length))} value={json} onChange={(e) => setJson(e.target.value)} />}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" size="sm" disabled={sending}>
            {sending ? <Loader2 className="animate-spin" /> : <Send />} {t("debug.answer")}
          </Button>
          {error ? <span className="text-[12px] text-bad">{error}</span> : <span className="text-[12px] text-subtle">{t("app.answer.hint")}</span>}
        </div>
      </form>
    </div>
  );
}

function FieldRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <span className="font-mono text-[12px] text-muted">{name}</span>
      {children}
    </>
  );
}
