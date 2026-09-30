/**
 * The run dialog: what the pipeline starts with.
 *
 * The starting frame is part of a run, not a property of the graph: an `entry`
 * node declares DEFAULT VALUES, and a name that already arrived from outside is
 * neither overwritten nor even evaluated by it. That is exactly why one and the
 * same graph can be run "as described", with a different `n`, or as a
 * subpipeline whose parent passed some of the variables in. Starting without
 * asking about those values would mean a graph cannot be run any other way than
 * as written in the JSON — which is precisely what debugging is for.
 *
 * So an empty field means "as in the pipeline": the declared value stands as a
 * placeholder, not as text. That way both what will happen by default and what
 * the user overrode are visible — and a computed variable (`total.$`) cannot be
 * wiped by accident.
 */
import { has, t, tn } from "./i18n.js";
import { formatLiteral, parseLiteral, varRows } from "./kinds.js";
import { Modal } from "./modal.js";
import { DELAY_PRESETS, parseDelay } from "./runner.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Asks for the starting variables.
 *
 * @param entry    the `entry` node of the root graph (may be null)
 * @param previous what was typed last time — {name: text}
 * @param delay    the current run pace, seconds
 * @param secretNames  the names of the keys the store will substitute INTO THIS graph
 * @param secretsStored how many keys the store holds in total
 * @param mode     "run" | "step" — only for the button caption
 * @returns Promise<{vars, entered, delay} | null> — null if cancelled
 */
export function askRunVars({
  entry, previous = {}, delay = 0, secretNames = [], secretsStored = 0, mode = "run",
} = {}) {
  const declared = entry ? varRows(entry) : [];

  return new Promise((resolve) => {
    let settled = false;
    const modal = new Modal(t(mode === "step" ? "rundlg.debug" : "rundlg.run"));
    const finish = (value) => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(value);
    };
    // closing by the cross or by the backdrop is a cancel, not a "run it empty"
    modal.overlay.addEventListener("pointerdown", (e) => {
      if (e.target === modal.overlay) finish(null);
    });
    modal.body.append(el("p", "sf-muted", entry
      ? t("rundlg.lead", { node: entry.id })
      : t("rundlg.leadNoEntry")));

    // The names of the keys to be substituted are not decoration. A key only
    // travels to a run if the graph refers to that name, and a mismatch ("the
    // store has OPENAI_KEY, the node reads OPENAI_API_KEY") otherwise looks like
    // "the key is filled in, and the stage says there is none". The values are
    // still not shown: a name is not a secret, the value is.
    if (secretNames.length) {
      modal.body.append(el("p", "sf-muted",
        t("rundlg.secrets", { names: secretNames.join(", ") })));
    } else if (secretsStored) {
      modal.body.append(el("p", "sf-run-warn",
        tn("rundlg.secretsUnused", secretsStored)));
    }

    const rows = el("div", "sf-run-vars");
    const inputs = new Map();

    for (const row of declared) {
      const line = el("div", "sf-run-var");
      line.append(el("span", "sf-run-var-name", row.name));
      const input = el("input");
      input.value = previous[row.name] ?? "";
      input.placeholder = row.source === "cel"
        ? `ƒ ${row.value ?? ""}`.slice(0, 48)
        : formatLiteral(parseLiteral(String(row.value ?? "")));
      input.title = t(row.source === "cel" ? "rundlg.celHint" : "rundlg.constHint");
      line.append(input);
      line.append(el("span", "sf-run-var-kind",
                     t(row.source === "cel" ? "field.source.cel" : "field.source.const")));
      inputs.set(row.name, input);
      rows.append(line);
    }

    // own variables: a graph can read what entry never declared
    const extra = el("div", "sf-run-var sf-run-var-extra");
    const extraName = el("input");
    extraName.placeholder = t("rundlg.ownVar");
    const extraValue = el("input");
    extraValue.placeholder = t("field.result.value");
    extra.append(extraName, extraValue);
    rows.append(extra);
    modal.body.append(rows);

    // The pace of a run is part of starting it, just as the variables are:
    // "show what is going on" is decided at the same moment as "what to run it
    // with", not after the graph has already flown past. In step debugging the
    // field is not useless either: the delay takes effect after "Continue".
    //
    // A field rather than a list: the ready-made values are a hint, not an
    // assortment. For a particular talk the pace is chosen by ear ("three
    // seconds a node, otherwise I cannot keep up"), and running into someone
    // else's list where a number simply has to be typed is a needless obstacle.
    const pace = el("div", "sf-run-var sf-run-var-pace");
    pace.append(el("span", "sf-run-var-name", t("rundlg.pace")));
    const delayInput = el("input");
    delayInput.type = "text";
    delayInput.inputMode = "decimal";
    delayInput.value = delay ? String(delay) : "";
    delayInput.placeholder = t("rundlg.pacePlaceholder");
    delayInput.title = t("rundlg.paceHint");
    // the ready-made values as the dropdown of the field itself: both pickable
    // and typeable
    const presets = el("datalist");
    presets.id = "sf-run-delays";
    for (const [value, key] of DELAY_PRESETS) {
      const option = el("option");
      option.value = String(value);
      const label = t(`delay.${key}`);
      option.label = has(`delay.${key}.hint`)
        ? `${label} — ${t(`delay.${key}.hint`)}`
        : label;
      presets.append(option);
    }
    delayInput.setAttribute("list", presets.id);
    pace.append(delayInput, presets);
    pace.append(el("span", "sf-run-var-kind", t("rundlg.paceUnit")));
    rows.append(pace);

    const collect = () => {
      const vars = {};
      const entered = {};
      for (const [name, input] of inputs) {
        const text = input.value;
        if (!text.trim()) continue; // "as in the pipeline"
        vars[name] = parseLiteral(text);
        entered[name] = text;
      }
      if (extraName.value.trim()) {
        vars[extraName.value.trim()] = parseLiteral(extraValue.value);
      }
      return { vars, entered, delay: parseDelay(delayInput.value) };
    };

    const actions = el("div", "sf-run-actions");
    const start = el("button", "sf-btn sf-primary",
      mode === "step" ? `⏯ ${t("rundlg.go.debug")}` : `▶ ${t("rundlg.go.run")}`);
    start.onclick = () => finish(collect());
    const cancel = el("button", "sf-btn", t("common.cancel"));
    cancel.onclick = () => finish(null);
    actions.append(start, cancel);
    modal.body.append(actions);

    modal.body.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(collect()); }
      if (e.key === "Escape") { e.preventDefault(); finish(null); }
    });

    modal.open();
    (inputs.values().next().value ?? extraName)?.focus?.();
  });
}
