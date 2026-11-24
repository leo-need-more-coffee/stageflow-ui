/**
 * The editor's dialogs, opened by name from anywhere: the menu, the command
 * palette, a keyboard shortcut. One is open at a time.
 */
import { Eye, EyeOff, Trash2, Upload } from "lucide-react";
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import { t, tn } from "@/core/i18n.js";
import { SECRET_MASK, validSecretName } from "@/core/secrets.js";
import { Badge, Button, cn, Dialog, Input, Label, Textarea } from "@/ui/kit";

import { useEditor } from "../context";
import type { Editor, RunAnswer, RunRequest } from "../editor";
import { RunDialog } from "./RunDialog";
import { ConnectForm } from "../connect/ConnectForm";

type Name = "import" | "export" | "settings" | "secrets" | "stages" | "connection" | "subpipeline";

interface Confirm {
  title: string;
  body: ReactNode;
  action: string;
  danger?: boolean;
  onConfirm: () => void;
}

interface Dialogs {
  open: (name: Name) => void;
  confirm: (request: Confirm) => void;
  newPipeline: () => void;
  askRun: (request: RunRequest) => Promise<RunAnswer | null>;
}

const DialogsContext = createContext<Dialogs | null>(null);

export function useDialogs(): Dialogs {
  const dialogs = useContext(DialogsContext);
  if (!dialogs) throw new Error("useDialogs outside DialogsProvider");
  return dialogs;
}

export function DialogsProvider({ children }: { children: ReactNode }) {
  const editor = useEditor();
  const [open, setOpen] = useState<Name | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [run, setRun] = useState<{ request: RunRequest; resolve: (a: RunAnswer | null) => void } | null>(null);

  const api = useMemo<Dialogs>(() => ({
    open: (name) => setOpen(name),
    confirm: (request) => setConfirm(request),
    newPipeline: () => {
      if (!editor.model.pipeline.nodes.length) {
        editor.model.reset();
        return;
      }
      setConfirm({
        title: t("file.new"), body: t("file.new.confirm"), action: t("app.dialog.discard"), danger: true,
        onConfirm: () => editor.model.reset(),
      });
    },
    askRun: (request) => new Promise((resolve) => setRun({ request, resolve })),
  }), [editor]);

  editor.askRun = api.askRun;
  const close = () => setOpen(null);

  return (
    <DialogsContext.Provider value={api}>
      {children}
      {open === "import" ? <ImportDialog editor={editor} onClose={close} /> : null}
      {open === "export" ? <ExportDialog editor={editor} onClose={close} /> : null}
      {open === "settings" ? <SettingsDialog editor={editor} onClose={close} /> : null}
      {open === "secrets" ? <SecretsDialog editor={editor} onClose={close} /> : null}
      {open === "stages" ? <StagesDialog editor={editor} onClose={close} /> : null}
      {open === "connection" ? <ConnectionDialog editor={editor} onClose={close} /> : null}
      {open === "subpipeline" ? <SubpipelineDialog editor={editor} onClose={close} /> : null}
      {confirm
        ? (
          <Dialog open onOpenChange={(o) => { if (!o) setConfirm(null); }} title={confirm.title}
            footer={(
              <>
                <Button onClick={() => setConfirm(null)}>{t("common.cancel")}</Button>
                <Button variant={confirm.danger ? "outline" : "primary"}
                  className={cn(confirm.danger && "border-bad/40 text-bad hover:bg-bad/10")}
                  onClick={() => { confirm.onConfirm(); setConfirm(null); }}>
                  {confirm.action}
                </Button>
              </>
            )}>
            <p className="text-[13px] text-muted">{confirm.body}</p>
          </Dialog>
        )
        : null}
      {run
        ? (
          <RunDialog request={run.request} onDone={(answer) => { run.resolve(answer); setRun(null); }} />
        )
        : null}
    </DialogsContext.Provider>
  );
}

// ---------------------------------------------------------- import/export

function ImportDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const load = () => {
    try {
      editor.setPipeline(JSON.parse(text));
      onClose();
    } catch (err: any) {
      setError(t("common.badJson", { reason: err.message }));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={t("import.title")} className="w-[min(640px,calc(100vw-32px))]"
      footer={(
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={!text.trim()} onClick={load}>{t("import.load")}</Button>
        </>
      )}>
      <div className="flex flex-col gap-3">
        <input ref={file} type="file" accept=".json,application/json" className="hidden"
          onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
        <Button className="self-start" onClick={() => file.current?.click()}><Upload /> {t("app.import.file")}</Button>
        <Textarea mono rows={14} value={text} onChange={(e) => { setText(e.target.value); setError(""); }}
          placeholder={t("import.placeholder")} />
        {error ? <div className="text-[12px] text-bad">{error}</div> : null}
      </div>
    </Dialog>
  );
}

function ExportDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const json = JSON.stringify(editor.getPipeline(), null, 2);
  const [copied, setCopied] = useState(false);
  const download = () => {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "pipeline.json";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={t("export.title")} className="w-[min(640px,calc(100vw-32px))]"
      footer={(
        <>
          <Button onClick={() => { void navigator.clipboard?.writeText(json); setCopied(true); }}>
            {copied ? t("app.export.copied") : t("export.copy")}
          </Button>
          <Button variant="primary" onClick={download}>{t("export.download")}</Button>
        </>
      )}>
      <Textarea mono readOnly rows={18} value={json} />
    </Dialog>
  );
}

// ---------------------------------------------- types, variables, metadata

function SettingsDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const model = editor.model;
  const sections: [string, string][] = [
    ["types", '{"User": {"id": "int", "name": "string"}}'],
    ["variables", '{"user": "User"}'],
    ["metadata", "{}"],
  ];
  const initial = Object.fromEntries(sections.map(([key]) => {
    const value = model.pipeline[key];
    return [key, value && Object.keys(value).length ? JSON.stringify(value, null, 2) : ""];
  }));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [error, setError] = useState("");
  const save = () => {
    try {
      const parsed = Object.fromEntries(sections.map(([key]) => [key, values[key].trim() ? JSON.parse(values[key]) : null]));
      for (const [key, value] of Object.entries(parsed)) {
        if (value === null) delete model.pipeline[key];
        else model.pipeline[key] = value;
      }
      model.touch();
      onClose();
    } catch (err: any) {
      setError(t("common.badJson", { reason: err.message }));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={t("settings.title")} className="w-[min(600px,calc(100vw-32px))]"
      footer={(
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={save}>{t("common.save")}</Button>
        </>
      )}>
      <div className="flex flex-col gap-4">
        {sections.map(([key, placeholder]) => (
          <div key={key} className="flex flex-col gap-1.5">
            <Label>{t(`settings.${key}`)}</Label>
            <Textarea mono rows={4} value={values[key]} placeholder={placeholder}
              onChange={(e) => { setValues({ ...values, [key]: e.target.value }); setError(""); }} />
          </div>
        ))}
        {error ? <div className="text-[12px] text-bad">{error}</div> : null}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- secrets

/**
 * API keys kept apart from the graph. A saved value is never shown again,
 * only replaced or deleted; the value being typed can be revealed, to catch
 * a typo before saving.
 */
function SecretsDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const secrets = editor.secrets;
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [peek, setPeek] = useState(false);
  const [error, setError] = useState("");
  const names: string[] = secrets.names();
  const save = () => {
    const key = name.trim();
    if (!validSecretName(key)) return setError(t("secrets.badName"));
    if (!value) return setError(t("secrets.emptyValue"));
    secrets.set(key, value);
    setName("");
    setValue("");
    setPeek(false);
    setError("");
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={t("secrets.title")} description={t("secrets.lead")}
      className="w-[min(580px,calc(100vw-32px))]">
      <div className="flex flex-col gap-4">
        <div className="overflow-hidden rounded-md border border-border">
          {!names.length ? <div className="px-3 py-4 text-center text-[12.5px] text-subtle">{t("secrets.none")}</div> : null}
          {names.map((key) => {
            const env = secrets.sourceOf(key) === "env";
            return (
              <div key={key} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
                <span className="flex-1 truncate font-mono text-[12.5px]">{key}</span>
                <span className="font-mono text-[12px] text-subtle">{SECRET_MASK}</span>
                <Badge tone={env ? "info" : "neutral"}>{t(env ? "secrets.from.env" : "secrets.from.browser")}</Badge>
                <Button variant="ghost" size="icon-sm" disabled={env} title={t(env ? "secrets.drop.env" : "secrets.drop")}
                  onClick={() => secrets.remove(key)}>
                  <Trash2 />
                </Button>
              </div>
            );
          })}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t("secrets.add")}</Label>
          <div className="flex gap-2">
            <Input mono className="w-[200px]" placeholder="OPENAI_API_KEY" value={name} onChange={(e) => setName(e.target.value)} />
            <div className="relative flex-1">
              <Input mono type={peek ? "text" : "password"} autoComplete="off" placeholder={t("secrets.value")}
                value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); }}
                className="pr-8" />
              <button type="button" title={t("secrets.peek")} onClick={() => setPeek(!peek)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-subtle hover:text-fg">
                {peek ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <Button variant="primary" onClick={save}>{t("common.save")}</Button>
          </div>
          {error ? <div className="text-[12px] text-bad">{error}</div> : null}
        </div>
        <p className="text-[12px] text-subtle">{t("secrets.note")}</p>
      </div>
    </Dialog>
  );
}

// ----------------------------------------------------------------- stages

function StagesDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const stages = editor.stages;
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={t("registry.title")}
      footer={(
        <>
          <Button onClick={() => file.current?.click()}><Upload /> {t("registry.fromFile")}</Button>
          <Button variant="primary" onClick={async () => { await editor.reloadStages(); onClose(); }}>{t("registry.reload")}</Button>
        </>
      )}>
      <input ref={file} type="file" accept=".json,application/json" className="hidden" onChange={async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        try {
          stages.setSpecs(JSON.parse(await f.text()), f.name);
          onClose();
        } catch (err: any) {
          setError(t("common.badJson", { reason: err.message }));
        }
      }} />
      <div className="flex flex-col gap-2 text-[13px] text-muted">
        <p>{stages.loaded ? tn("registry.loaded", stages.names().length, { source: stages.source }) : t("registry.empty")}</p>
        <p>{t("registry.note", { url: editor.backend.url })}</p>
        {error ? <div className="text-[12px] text-bad">{error}</div> : null}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------- connection

/**
 * Address, credential and plan in one place: what am I talking to, as whom,
 * seeing which plan. Only a new address reloads the page; the credential and
 * plan are applied in place.
 */
function ConnectionDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const { backend, capabilities } = editor;
  const [changing, setChanging] = useState(false);
  const [header, setHeader] = useState(backend.auth.header);
  const [value, setValue] = useState(backend.auth.value);
  const [say, setSay] = useState<{ text: string; tone: "ok" | "bad" | "wait" } | null>(null);
  const own = capabilities.previewing ? null : capabilities.plan;

  if (changing) {
    return (
      <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={t("conn.change")}>
        <ConnectForm storageKey={editor.options.storageKey ?? null} force
          onCancel={() => setChanging(false)}
          onConnected={async (next) => {
            if (next.url !== backend.url) {
              location.reload();
              return;
            }
            await editor.setCredential(next.auth).catch(() => {});
            onClose();
          }} />
      </Dialog>
    );
  }

  const apply = async () => {
    setSay({ text: t("conn.checking"), tone: "wait" });
    try {
      const count = await editor.setCredential({ header, value });
      setSay({ text: value.trim() ? tn("conn.auth.accepted", count) : tn("conn.auth.cleared", count), tone: "ok" });
    } catch (err: any) {
      setSay({ text: t("conn.auth.rejected", { reason: err.message ?? err }), tone: "bad" });
    }
  };

  const section = "flex flex-col gap-2 border-b border-border pb-4 last:border-b-0 last:pb-0";
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={t("conn.title")} className="w-[min(560px,calc(100vw-32px))]">
      <div className="flex flex-col gap-4">
        <div className={section}>
          <div className="flex items-center justify-between">
            <Label>{t("conn.backend")}</Label>
            <Button size="sm" variant="ghost" onClick={() => setChanging(true)}>{t("conn.change")}</Button>
          </div>
          <div className="font-mono text-[13px]">{backend.url}</div>
          <p className="text-[12px] text-subtle">{t("conn.backend.note")}</p>
        </div>

        <div className={section}>
          <Label>{t("conn.auth")}</Label>
          <div className="flex gap-2">
            <Input mono className="w-[150px]" placeholder="Authorization" value={header} onChange={(e) => setHeader(e.target.value)} />
            <Input mono type="password" autoComplete="off" className="flex-1"
              placeholder={backend.authenticated ? t("conn.auth.kept") : "Bearer …"}
              value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void apply(); }} />
            <Button variant="primary" onClick={() => void apply()}>{t("conn.apply")}</Button>
          </div>
          {say ? <div className={cn("text-[12px]", say.tone === "ok" ? "text-ok" : say.tone === "bad" ? "text-bad" : "text-muted")}>{say.text}</div> : null}
          <p className="text-[12px] text-subtle">{t("conn.auth.note")}</p>
        </div>

        {capabilities.plans
          ? (
            <div className={section}>
              <Label>{t("conn.plan")}</Label>
              <p className="text-[12px] text-subtle">{t("conn.plan.note")}</p>
              <div className="flex flex-col gap-1">
                {[null, ...capabilities.plans].map((plan: string | null) => (
                  <button key={plan ?? "-"} type="button" onClick={() => void editor.setPlan(plan)}
                    className={cn("flex items-center gap-3 rounded-md border px-3 py-2 text-left",
                      (plan ?? null) === backend.plan ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2")}>
                    <code className="font-mono text-[12.5px]">{plan ?? t("conn.plan.mine")}</code>
                    <span className="text-[12px] text-muted">
                      {plan === null
                        ? (own ? t("conn.plan.mine.is", { plan: own }) : t("conn.plan.mine.unknown"))
                        : t(plan === own ? "conn.plan.same" : "conn.plan.preview")}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )
          : null}

        {capabilities.probed
          ? (
            <div className={section}>
              <Label>{t("conn.answer")}</Label>
              {capabilities.known
                ? (
                  <>
                    <div className="font-mono text-[12.5px]">{capabilities.summary()}</div>
                    <p className="text-[12px] text-muted">{t("conn.answer.runs", { types: capabilities.nodeTypes.join(", ") })}</p>
                  </>
                )
                : <p className="text-[12px] text-muted">{t("conn.answer.none")}</p>}
            </div>
          )
          : null}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------ subpipeline

function SubpipelineDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  const create = () => {
    const clean = id.trim();
    if (!clean || !editor.model.addSubpipeline(clean)) return setError(t("graph.add.taken"));
    editor.openGraph(clean);
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={t("app.graph.new")} description={t("app.graph.newLead")}
      footer={(
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={create}>{t("app.graph.create")}</Button>
        </>
      )}>
      <div className="flex flex-col gap-1.5">
        <Input mono autoFocus value={id} placeholder="review" onChange={(e) => { setId(e.target.value); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
        {error ? <div className="text-[12px] text-bad">{error}</div> : null}
      </div>
    </Dialog>
  );
}
