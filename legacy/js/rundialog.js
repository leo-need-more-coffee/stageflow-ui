/**
 * The run dialog: the starting variables and the pace of a run.
 *
 * An `entry` node only declares defaults; a variable supplied from outside is
 * not overwritten. So the same graph can be run as written, with another `n`,
 * or as a subpipeline given some variables by its parent, and the dialog asks
 * for those values.
 *
 * An empty field means "as in the pipeline": the declared value is shown as a
 * placeholder, so defaults and overrides are both visible and a computed
 * variable (`total.$`) cannot be wiped by accident.
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
 * Ask for the starting variables.
 *
 * @param entry         the root graph's `entry` node (may be null)
 * @param previous      what was typed last time, {name: text}
 * @param delay         the current pace, seconds
 * @param secretNames   names of the keys that will be supplied to this graph
 * @param secretsStored how many keys the store holds
 * @param mode          "run" | "step", for the button caption
 * @returns Promise<{vars, entered, delay} | null>, null if cancelled
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
    // closing with the cross or the backdrop cancels
    modal.overlay.addEventListener("pointerdown", (e) => {
      if (e.target === modal.overlay) finish(null);
    });
    modal.body.append(el("p", "sf-muted", entry
      ? t("rundlg.lead", { node: entry.id })
      : t("rundlg.leadNoEntry")));

    // List the keys that will be supplied: a key is only sent if the graph
    // uses its name, so a mismatch (OPENAI_KEY stored, OPENAI_API_KEY read)
    // shows up here. Names only; values are never shown.
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

    // variables entry does not declare: a graph can read those too
    const extra = el("div", "sf-run-var sf-run-var-extra");
    const extraName = el("input");
    extraName.placeholder = t("rundlg.ownVar");
    const extraValue = el("input");
    extraValue.placeholder = t("field.result.value");
    extra.append(extraName, extraValue);
    rows.append(extra);
    modal.body.append(rows);

    // The pace is chosen with the variables, before the run. In step mode it
    // applies after "Continue". A free number field with suggestions, since
    // the right pace is usually picked by ear.
    const pace = el("div", "sf-run-var sf-run-var-pace");
    pace.append(el("span", "sf-run-var-name", t("rundlg.pace")));
    const delayInput = el("input");
    delayInput.type = "text";
    delayInput.inputMode = "decimal";
    delayInput.value = delay ? String(delay) : "";
    delayInput.placeholder = t("rundlg.pacePlaceholder");
    delayInput.title = t("rundlg.paceHint");
    // suggestions in the field's own dropdown: pick one or type
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
