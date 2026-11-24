/**
 * The bar along the top: where you are, whether the graph is sound, and the
 * one thing you came to do, run it.
 *
 * Everything else (files, settings, secrets, the connection) is behind the
 * menu on the right and the command palette (Ctrl+K); the bar itself stays
 * short enough to read at a glance.
 */
import {
  AlertTriangle, Bug, Check, ChevronDown, CircleCheck, Layers, Loader2, Monitor, Moon, MoreHorizontal,
  Pause, Play, Plus, Redo2, Search, SkipForward, Square, Sun, Undo2, Variable,
} from "lucide-react";

import { delayLabel, DELAY_PRESETS } from "@/core/runner.js";
import { has, locale, locales, setLocale, t, tn } from "@/core/i18n.js";
import {
  Badge, Button, Kbd, Menu, MenuCheck, MenuContent, MenuItem, MenuLabel, MenuRadio, MenuSeparator, MenuSub, MenuTrigger,
  Popover, PopoverContent, PopoverTrigger, Tip,
} from "@/ui/kit";

import { useEditor } from "./context";
import type { Editor } from "./editor";
import { useDialogs } from "./dialogs/Dialogs";
import { setTheme, useTheme } from "./theme";
import { VariablesPanel } from "./VariablesPanel";

const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

function Logo() {
  return (
    <div className="flex items-center gap-2 px-1">
      <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden>
        <path d="M8 1.5 14.5 8 8 14.5 1.5 8z" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M8 5.5 10.5 8 8 10.5 5.5 8z" fill="var(--accent)" />
      </svg>
      <span className="text-[13.5px] font-semibold tracking-tight">StageFlow</span>
    </div>
  );
}

function GraphSwitcher({ editor }: { editor: Editor }) {
  const dialogs = useDialogs();
  const model = editor.model;
  const subs = Object.keys(model.pipeline.subpipelines ?? {});
  // what is shown: a subpipeline opened alone, or the main graph (with frames)
  const current = editor.standalone ?? (editor.framed ? null : model.graphKey);
  return (
    <div className="flex items-center text-[13px]">
      {current !== null
        ? (
          <>
            <button type="button" onClick={() => editor.openGraph(null)}
              className="h-8 rounded-md px-2 text-muted hover:bg-surface-2 hover:text-fg">
              {t("app.graph.main")}
            </button>
            <span className="px-0.5 text-subtle">/</span>
          </>
        )
        : null}
      <Menu>
        <MenuTrigger asChild>
          <Button variant="ghost" size="md" className="gap-1 px-2 font-medium text-fg" aria-label={t("app.graph.switch")}>
            {current === null ? t("app.graph.main") : <span className="font-mono text-[12.5px]">{current}</span>}
            <ChevronDown className="!size-3.5 text-subtle" />
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>{t("app.graph.graphs")}</MenuLabel>
          <MenuItem icon={current === null ? <Check /> : <span className="size-4" />} onSelect={() => editor.openGraph(null)}>
            {t("app.graph.main")}
          </MenuItem>
          {subs.map((key) => (
            <MenuItem key={key} icon={current === key ? <Check /> : <Layers />} onSelect={() => editor.openGraph(key)}>
              <span className="font-mono text-[12.5px]">{key}</span>
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuCheck checked={editor.showSubgraphs} onCheckedChange={() => editor.toggleSubgraphs()}>{t("app.graph.beside")}</MenuCheck>
          <MenuItem icon={<Plus />} onSelect={() => dialogs.open("subpipeline")}>{t("app.graph.new")}</MenuItem>
          {current !== null
            ? (
              <MenuItem danger onSelect={() => dialogs.confirm({
                title: t("app.graph.remove", { id: current }),
                body: t("graph.remove.confirm", { id: current }),
                action: t("app.menu.delete"),
                danger: true,
                onConfirm: () => {
                  editor.selection.clear();
                  model.removeSubpipeline(current);
                },
              })}>
                {t("app.graph.remove", { id: current })}
              </MenuItem>
            )
            : null}
        </MenuContent>
      </Menu>
    </div>
  );
}

function IssuesChip({ editor }: { editor: Editor }) {
  const issues = editor.issues;
  if (!issues.length) {
    return (
      <span className="flex h-8 items-center gap-1.5 px-2 text-[12px] text-muted">
        <CircleCheck size={14} className="text-ok" /> {t("app.issues.none")}
      </span>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="md" className="text-[12px] text-bad hover:text-bad">
          <AlertTriangle /> {tn("app.issues.count", issues.length)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-1">
        <div className="max-h-[50vh] overflow-y-auto">
          {issues.map((issue, i) => (
            <button key={i} type="button" onClick={() => editor.reveal(issue)}
              className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left hover:bg-surface-2">
              <span className="font-mono text-[11.5px] text-muted">
                {issue.graph === null ? "" : `${issue.graph} / `}{issue.node ?? t("app.issues.graph")}
              </span>
              <span className="text-[12.5px] text-fg">{issue.message}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function RunControls({ editor }: { editor: Editor }) {
  const runner = editor.runner;
  if (runner.active || runner.awaitingInput) {
    return (
      <div className="flex items-center gap-1">
        {runner.active
          ? (
            <>
              <Tip content={runner.waiting ? t("run.continue") : t("run.pause")}>
                <Button size="icon" variant="ghost" onClick={() => (runner.waiting ? runner.resume() : runner.pause())}>
                  {runner.waiting ? <Play /> : <Pause />}
                </Button>
              </Tip>
              <Tip content={t("run.step")} shortcut="F10">
                <Button size="icon" variant="ghost" onClick={() => runner.step()}><SkipForward /></Button>
              </Tip>
            </>
          )
          : null}
        <Button size="md" variant="outline" onClick={() => runner.stop()}>
          <Square className="!size-3 fill-current" /> {t("run.stop")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center">
      <Tip content={t("app.run.tip", { pace: delayLabel(editor.runDelay) })} shortcut="F5">
        <Button variant="primary" size="md" className="rounded-r-none pl-2.5" onClick={() => void editor.run({ mode: "run" })}>
          <Play className="fill-current !size-3.5" /> {t("run.start")}
        </Button>
      </Tip>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="primary" size="md" className="rounded-l-none border-l border-l-black/15 px-2" aria-label={t("app.run.more")}>
            <ChevronDown />
          </Button>
        </MenuTrigger>
        <MenuContent align="end" className="w-[260px]">
          <MenuItem icon={<Play />} shortcut="F5" onSelect={() => void editor.run({ mode: "run" })}>{t("run.start")}</MenuItem>
          <MenuItem icon={<Bug />} shortcut="⇧F5" onSelect={() => void editor.run({ mode: "step" })}>{t("run.debug")}</MenuItem>
          <MenuSeparator />
          <MenuLabel>{t("run.delay")}</MenuLabel>
          <MenuRadio
            value={String(editor.runDelay)}
            onChange={(v) => editor.setRunDelay(Number(v))}
            options={[
              ...DELAY_PRESETS.map(([value, key]: [number, string]) => ({
                value: String(value), label: t(`delay.${key}`),
                hint: has(`delay.${key}.hint`) ? t(`delay.${key}.hint`) : undefined,
              })),
              ...(DELAY_PRESETS.some(([value]: [number]) => value === editor.runDelay)
                ? [] : [{ value: String(editor.runDelay), label: delayLabel(editor.runDelay), hint: t("delay.custom.hint") }]),
            ]}
          />
        </MenuContent>
      </Menu>
    </div>
  );
}

function RunStatus({ editor }: { editor: Editor }) {
  const runner = editor.runner;
  const tone = {
    running: "accent", paused: "warn", awaiting: "warn", finished: "ok", stopped: "neutral", failed: "bad",
  }[runner.status as string] as any;
  if (!tone) return null;
  return (
    <Badge tone={tone} className="h-6 px-2.5">
      {runner.status === "running" ? <Loader2 size={11} className="animate-spin" /> : null}
      {t(`status.${runner.status}`)}
      {runner.node && (runner.active || runner.awaitingInput) ? <span className="font-mono">· {runner.node}</span> : null}
    </Badge>
  );
}

export function TopBar({ onCommand }: { onCommand: () => void }) {
  const editor = useEditor();
  const dialogs = useDialogs();
  const theme = useTheme();
  const languages = locales();

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-surface px-3">
      <Logo />
      <div className="mx-2 h-5 w-px bg-border" />
      <GraphSwitcher editor={editor} />

      <div className="flex-1" />

      {/* while a run is on, its state is what matters; soundness comes back after */}
      {editor.runner.status && editor.runner.status !== "idle" && (editor.runner.active || editor.runner.awaitingInput)
        ? <RunStatus editor={editor} />
        : <IssuesChip editor={editor} />}

      <div className="mx-1 h-5 w-px bg-border" />
      <div className="flex items-center">
        <Tip content={t("edit.undo")} shortcut={`${mod}Z`}>
          <Button variant="ghost" size="icon" disabled={!editor.model.canUndo} onClick={() => editor.undo()}><Undo2 /></Button>
        </Tip>
        <Tip content={t("edit.redo")} shortcut={`${mod}⇧Z`}>
          <Button variant="ghost" size="icon" disabled={!editor.model.canRedo} onClick={() => editor.redo()}><Redo2 /></Button>
        </Tip>
      </div>

      <Popover>
        <Tip content={t("app.vars.tip")}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("app.vars.title")}><Variable /></Button>
          </PopoverTrigger>
        </Tip>
        <PopoverContent align="end" className="w-[420px] p-0">
          <VariablesPanel />
        </PopoverContent>
      </Popover>

      <div className="mx-1 h-5 w-px bg-border" />
      <button type="button" onClick={onCommand}
        className="mr-1 flex h-8 w-[208px] items-center gap-2 rounded-md border border-border bg-surface pl-2.5 pr-1.5 text-[12.5px] text-subtle transition-colors hover:border-border-strong hover:text-muted">
        <Search size={14} />
        <span className="flex-1 text-left">{t("app.cmd.placeholderShort")}</span>
        <Kbd>{mod}K</Kbd>
      </button>

      <RunControls editor={editor} />

      <Menu>
        <MenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t("app.more")}><MoreHorizontal /></Button>
        </MenuTrigger>
        <MenuContent align="end" className="w-[250px]">
          <MenuItem onSelect={() => dialogs.newPipeline()}>{t("file.new")}</MenuItem>
          <MenuItem onSelect={() => dialogs.open("import")}>{t("file.import")}</MenuItem>
          <MenuItem shortcut={`${mod}S`} onSelect={() => void editor.save()}>{t("app.save")}</MenuItem>
          <MenuItem onSelect={() => dialogs.open("export")}>{t("file.export")}</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => dialogs.open("settings")}>{t("file.settings")}</MenuItem>
          <MenuItem onSelect={() => dialogs.open("secrets")}
            shortcut={editor.secrets.size ? String(editor.secrets.size) : undefined}>{t("file.secrets")}</MenuItem>
          <MenuItem onSelect={() => dialogs.open("stages")}
            shortcut={editor.stages.loaded ? String(editor.stages.names().length) : undefined}>{t("file.registry")}</MenuItem>
          <MenuItem onSelect={() => dialogs.open("connection")}>{t("file.connection")}</MenuItem>
          <MenuSeparator />
          <MenuSub label={t("app.theme")} icon={theme === "dark" ? <Moon /> : theme === "light" ? <Sun /> : <Monitor />}>
            <MenuRadio value={theme} onChange={(v) => setTheme(v)} options={[
              { value: "system", label: t("app.theme.system") },
              { value: "light", label: t("app.theme.light") },
              { value: "dark", label: t("app.theme.dark") },
            ]} />
          </MenuSub>
          {Object.keys(languages).length > 1
            ? (
              <MenuSub label={t("view.language")}>
                <MenuRadio value={locale()} onChange={(v) => setLocale(v)}
                  options={Object.entries(languages).map(([tag, name]) => ({ value: tag, label: name as string }))} />
              </MenuSub>
            )
            : null}
        </MenuContent>
      </Menu>
    </header>
  );
}
