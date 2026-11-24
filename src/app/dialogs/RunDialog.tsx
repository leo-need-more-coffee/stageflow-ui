/**
 * Before a run: the starting variables and the pace.
 *
 * An `entry` node only declares defaults, so the same graph can be run as
 * written or with another value. An empty field means "as in the pipeline":
 * the declared value is the placeholder, so a computed default (`total.$`)
 * cannot be wiped by accident.
 */
import { Bug, Play, Plus } from "lucide-react";
import { useState } from "react";

import { t, tn } from "@/core/i18n.js";
import { formatLiteral, parseLiteral, varRows } from "@/core/kinds.js";
import { DELAY_PRESETS, parseDelay } from "@/core/runner.js";
import { Button, Dialog, Input, Kbd, Label, Segmented } from "@/ui/kit";

import type { RunAnswer, RunRequest } from "../editor";

export function RunDialog({ request, onDone }: { request: RunRequest; onDone: (answer: RunAnswer | null) => void }) {
  const declared: any[] = request.entry ? varRows(request.entry) : [];
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...request.previous }));
  const [extra, setExtra] = useState<{ name: string; value: string }[]>([]);
  const [delay, setDelay] = useState(request.delay ? String(request.delay) : "0");

  const collect = (): RunAnswer => {
    const vars: Record<string, unknown> = {};
    const entered: Record<string, string> = {};
    for (const row of declared) {
      const text = values[row.name] ?? "";
      if (!text.trim()) continue;
      vars[row.name] = parseLiteral(text);
      entered[row.name] = text;
    }
    for (const row of extra) if (row.name.trim()) vars[row.name.trim()] = parseLiteral(row.value);
    return { vars, entered, delay: parseDelay(delay) };
  };
  const step = request.mode === "step";
  const presets = DELAY_PRESETS.filter(([value]: [number]) => value <= 2);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onDone(null); }}
      title={t(step ? "rundlg.debug" : "rundlg.run")}
      description={request.entry ? t("rundlg.lead", { node: request.entry.id }) : t("rundlg.leadNoEntry")}
      footer={(
        <>
          <span className="mr-auto flex items-center gap-1 text-[12px] text-subtle"><Kbd>Enter</Kbd> {t("app.run.enter")}</span>
          <Button onClick={() => onDone(null)}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => onDone(collect())}>
            {step ? <Bug /> : <Play className="fill-current !size-3.5" />}
            {t(step ? "rundlg.go.debug" : "rundlg.go.run")}
          </Button>
        </>
      )}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); onDone(collect()); }}>
        {request.secretNames.length
          ? <p className="text-[12px] text-muted">{t("rundlg.secrets", { names: request.secretNames.join(", ") })}</p>
          : request.secretsStored
            ? <p className="text-[12px] text-warn">{tn("rundlg.secretsUnused", request.secretsStored)}</p>
            : null}

        {declared.length
          ? (
            <div className="flex flex-col gap-2">
              <Label>{t("app.run.vars")}</Label>
              {declared.map((row, i) => (
                <div key={row.name} className="grid grid-cols-[140px_1fr] items-center gap-3">
                  <span className="truncate font-mono text-[12.5px]">{row.name}</span>
                  <Input mono autoFocus={i === 0} value={values[row.name] ?? ""}
                    title={t(row.source === "cel" ? "rundlg.celHint" : "rundlg.constHint")}
                    placeholder={row.source === "cel" ? `ƒ ${row.value ?? ""}`.slice(0, 48) : formatLiteral(parseLiteral(String(row.value ?? "")))}
                    onChange={(e) => setValues({ ...values, [row.name]: e.target.value })} />
                </div>
              ))}
            </div>
          )
          : null}

        <div className="flex flex-col gap-2">
          {extra.map((row, i) => (
            <div key={i} className="grid grid-cols-[140px_1fr] gap-3">
              <Input mono placeholder={t("rundlg.ownVar")} value={row.name}
                onChange={(e) => setExtra(extra.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} />
              <Input mono placeholder={t("field.result.value")} value={row.value}
                onChange={(e) => setExtra(extra.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))} />
            </div>
          ))}
          <div>
            <Button size="sm" variant="ghost" className="-ml-2" onClick={() => setExtra([...extra, { name: "", value: "" }])}>
              <Plus /> {t("app.run.addVar")}
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <div>
            <Label>{t("rundlg.pace")}</Label>
            <div className="text-[11.5px] text-subtle">{t("rundlg.paceHint")}</div>
          </div>
          <Segmented size="sm" value={presets.some(([v]: [number]) => String(v) === delay) ? delay : "custom"}
            onChange={(v) => setDelay(v)}
            options={presets.map(([value, key]: [number, string]) => ({ value: String(value), label: t(`delay.${key}`) }))} />
        </div>
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}
