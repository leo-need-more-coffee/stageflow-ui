/**
 * Picking a node to add.
 *
 * A backend may have hundreds of stages, so this is a finder rather than a
 * list: categories on the left, what matches in the middle with a line of
 * description each, and the highlighted stage's inputs and outputs on the
 * right, so a stage can be told from its neighbours before it is placed.
 *
 * The search is by words: every word typed has to be found somewhere — the
 * name, a part of it (`customer` in LoadCustomerStage), its initials (`lcs`),
 * an argument, the category or the description — and a hit in the name
 * counts for more than one in the description. The stages picked last come
 * first while nothing is typed.
 *
 * The same finder opens from the "+" button, the A key, a double click on the
 * canvas, a wire dropped on empty canvas and the "+" on an edge.
 */
import { Clock, Search, Shapes } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { has, t } from "@/core/i18n.js";
import { rank, splitName, tokensOf } from "@/core/search.js";
import { KINDS, StageKind } from "@/core/kinds.js";
import { canContinue } from "@/core/wiring.js";
import { cn, Kbd } from "@/ui/kit";

import { useEditor } from "./context";
import { KindIcon, NodeIcon } from "./kindIcon";

export interface NodeSpec {
  type: string;
  extra: Record<string, unknown>;
}

interface Entry {
  key: string;
  spec: NodeSpec;
  name: string;
  description: string;
  category: string | null;   // null for the node kinds
  categoryLabel: string;
  disabled: string | null;   // why it cannot be used, if it cannot
  stage: any | null;
  words: string[];           // the name split into its parts, lower case
  initials: string;
  args: string[];
}

const RECENT_KEY = "stageflow-editor:recent-stages";
const RECENT_MAX = 8;

function readRecent(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function remember(key: string) {
  try {
    const next = [key, ...readRecent().filter((k) => k !== key)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* nowhere to remember it */ }
}

/** A category's name for people: the catalog's word, else its last part. */
export function categoryName(category: string): string {
  const name = has(`category.${category}`)
    ? t(`category.${category}`)
    : (category.split(".").pop() ?? category).replace(/[_-]/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

type Filter = "all" | "recent" | "kinds" | string;

export function AddNodeMenu({ onPick, onlyContinuing = false, autoFocus = true }:
  { onPick: (spec: NodeSpec) => void; onlyContinuing?: boolean; autoFocus?: boolean }) {
  const editor = useEditor();
  const env = { stages: editor.stages, backend: editor.backend };
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>(() => (readRecent().length ? "recent" : "all"));
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const kind of KINDS.values() as Iterable<any>) {
      if (kind === StageKind) continue;
      if (onlyContinuing && !canContinue(kind.type)) continue;
      const unsupported = editor.capabilities?.supports(kind.type) === false;
      out.push({
        key: `kind:${kind.type}`, spec: { type: kind.type, extra: {} }, name: kind.title,
        description: kind.description({}, env) || "", category: null, categoryLabel: t("app.add.kinds"),
        disabled: unsupported ? editor.capabilities.reason(kind.type) : null, stage: null,
        words: [...splitName(kind.title), kind.type], initials: "", args: [],
      });
    }
    for (const name of editor.stages.names() as string[]) {
      if (onlyContinuing && !canContinue("stage", { stage: name })) continue;
      const spec = editor.stages.get(name);
      const category = spec?.category ?? "default";
      const words = splitName(name);
      out.push({
        key: `stage:${name}`, spec: { type: "stage", extra: { stage: name } }, name,
        description: typeof spec?.description === "string" ? spec.description : "",
        category, categoryLabel: categoryName(category), disabled: null, stage: spec,
        words, initials: words.map((w: string) => w[0]).join(""),
        args: [...(spec?.arguments ?? []), ...(spec?.outputs ?? [])].map((a: any) => a.name).filter((n: string) => n && n !== "*"),
      });
    }
    return out;
    // the stage library and capabilities redraw the editor, which re-runs this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.version, onlyContinuing]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) if (e.category) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    // grouped by the part before the dot: builtin.lists and builtin.logic together
    const groups = new Map<string, { category: string; count: number }[]>();
    for (const [category, count] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
      const group = category.includes(".") ? category.split(".")[0] : "";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push({ category, count });
    }
    return groups;
  }, [entries]);

  const recent = readRecent();
  const tokens = tokensOf(query);
  const searching = tokens.length > 0;

  const shown = useMemo<Entry[]>(() => {
    let pool = entries;
    if (!searching) {
      if (filter === "recent") {
        pool = recent.map((k) => entries.find((e) => e.key === k)).filter(Boolean) as Entry[];
      } else if (filter === "kinds") pool = entries.filter((e) => !e.category);
      else if (filter !== "all") pool = entries.filter((e) => e.category === filter);
      return pool;
    }
    if (filter !== "all" && filter !== "recent") {
      pool = filter === "kinds" ? entries.filter((e) => !e.category) : entries.filter((e) => e.category === filter);
    }
    return rank(pool, query, (e: Entry) => (recent.includes(e.key) ? 5 : 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, filter, query]);

  useEffect(() => setActive(0), [filter, query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (entry: Entry | undefined) => {
    if (!entry || entry.disabled) return;
    if (entry.category) remember(entry.key);
    onPick(entry.spec);
  };

  const current = shown[active];
  const total = entries.length;

  const railItem = (value: Filter, label: ReactNode, count?: number, icon?: ReactNode) => (
    <button key={value} type="button" onClick={() => setFilter(value)}
      className={cn("flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px]",
        filter === value ? "bg-surface-2 font-medium text-fg" : "text-muted hover:text-fg")}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? <span className="text-[11px] tabular-nums text-subtle">{count}</span> : null}
    </button>
  );

  return (
    <div className="flex h-[min(460px,70vh)] w-[min(760px,calc(100vw-32px))] flex-col"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
        if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
        if (e.key === "Enter") { e.preventDefault(); pick(current); }
      }}>
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search size={15} className="text-subtle" />
        <input autoFocus={autoFocus} value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={t("app.add.search")} spellCheck={false}
          className="h-11 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-subtle focus-visible:outline-none" />
        <span className="text-[11px] text-subtle">{t("app.add.count", { shown: shown.length, total })}</span>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="w-[184px] shrink-0 overflow-y-auto border-r border-border p-1.5">
          {railItem("all", t("app.add.all"), entries.length)}
          {recent.length ? railItem("recent", t("app.add.recent"), undefined, <Clock size={13} />) : null}
          {railItem("kinds", t("app.add.kinds"), entries.filter((e) => !e.category).length, <Shapes size={13} />)}
          {[...categories].map(([group, items]) => (
            <div key={group} className="mt-2">
              {group ? <div className="px-2 pb-1 pt-1 text-[11px] font-medium text-subtle">{categoryName(group)}</div> : null}
              {items.map(({ category, count }) => railItem(category, categoryName(category), count))}
            </div>
          ))}
        </nav>

        <div ref={list} className="min-w-0 flex-1 overflow-y-auto p-1.5">
          {!shown.length
            ? <div className="px-3 py-8 text-center text-[13px] text-muted">{t(filter === "recent" && !searching ? "app.add.noRecent" : "app.add.nothing")}</div>
            : null}
          {shown.map((entry, i) => (
            <button key={entry.key} type="button" data-index={i} disabled={Boolean(entry.disabled)}
              onMouseMove={() => setActive(i)} onClick={() => pick(entry)}
              className={cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left disabled:opacity-40",
                i === active && "bg-surface-2")}>
              {entry.category
                ? <NodeIcon node={{ id: "", type: "stage", stage: entry.name }} env={env} size={26} />
                : <KindIcon type={entry.spec.type} size={26} />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Highlight text={entry.name} tokens={tokens} className={cn("truncate text-[13px]", entry.category && "font-mono text-[12.5px]")} />
                  {(searching || filter === "all" || filter === "recent") && entry.category
                    ? <span className="shrink-0 text-[11px] text-subtle">{entry.categoryLabel}</span>
                    : null}
                </div>
                <div className="truncate text-[11.5px] text-muted">{entry.disabled ?? entry.description}</div>
              </div>
            </button>
          ))}
        </div>

        <Preview entry={current} />
      </div>

      <div className="flex h-8 items-center gap-4 border-t border-border px-3 text-[11px] text-subtle">
        <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd>{t("app.add.keysMove")}</span>
        <span className="flex items-center gap-1.5"><Kbd>Enter</Kbd>{t("app.add.keysPick")}</span>
        <span className="flex items-center gap-1.5"><Kbd>Esc</Kbd>{t("app.add.keysClose")}</span>
      </div>
    </div>
  );
}

/** The parts of a name a typed word matched, in bold. */
function Highlight({ text, tokens, className }: { text: string; tokens: string[]; className?: string }) {
  if (!tokens.length) return <span className={className}>{text}</span>;
  const lower = text.toLowerCase();
  const marks = new Array(text.length).fill(false);
  for (const token of tokens) {
    const at = lower.indexOf(token);
    if (at >= 0) for (let i = at; i < at + token.length; i++) marks[i] = true;
  }
  const parts: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && marks[j] === marks[i]) j++;
    const piece = text.slice(i, j);
    parts.push(marks[i] ? <mark key={i} className="bg-transparent font-semibold text-accent">{piece}</mark> : piece);
    i = j;
  }
  return <span className={className}>{parts}</span>;
}

function Preview({ entry }: { entry: Entry | undefined }) {
  if (!entry) return <div className="w-[240px] shrink-0 border-l border-border" />;
  const spec = entry.stage;
  const section = (title: string, fields: any[], required = true) => (fields.length
    ? (
      <div>
        <div className="mb-1.5 text-[11px] font-medium text-subtle">{title}</div>
        <div className="flex flex-col gap-1">
          {fields.filter((f) => f.name !== "*").map((f) => (
            <div key={f.name} className="flex items-baseline gap-1.5 text-[11.5px]">
              <span className="font-mono text-fg">{f.name}</span>
              {required && f.optional === false ? <span className="text-bad">*</span> : null}
              {f.type ? <span className="font-mono text-subtle">{f.type}</span> : null}
            </div>
          ))}
        </div>
      </div>
    )
    : null);
  return (
    <aside className="flex w-[240px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-3">
      <div className="flex flex-col gap-0.5">
        <div className={cn("break-words text-[13px] font-medium", entry.category && "font-mono text-[12.5px]")}>{entry.name}</div>
        <div className="text-[11px] text-subtle">{entry.categoryLabel}</div>
      </div>
      {entry.description ? <p className="text-[12px] leading-relaxed text-muted">{entry.description}</p> : null}
      {spec ? section(t("spec.arguments"), spec.arguments ?? []) : null}
      {spec ? section(t("spec.outputs"), spec.outputs ?? [], false) : null}
    </aside>
  );
}
