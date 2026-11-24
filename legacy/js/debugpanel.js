/**
 * The debug panel: the run's state and controls, the frame and the event log.
 *
 * A panel at the bottom rather than an inspector tab, so the graph, the
 * variables and the step buttons are visible together while the inspector
 * keeps showing the selected node.
 *
 * It is built once and patched on each event; redrawing it whole would throw
 * away a variable value being typed.
 */
import { t } from "./i18n.js";
import { formatLiteral, outputRows, parseLiteral } from "./kinds.js";
import { SECRET_MASK } from "./secrets.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const STATUS = {
  running: { glyph: "▶", key: "status.running" },
  paused: { glyph: "⏸", key: "debug.paused" },
  awaiting: { glyph: "⏳", key: "debug.awaiting" },
  finished: { glyph: "✓", key: "status.finished" },
  stopped: { glyph: "⏹", key: "status.stopped" },
  failed: { glyph: "✕", key: "status.failed" },
};

export class DebugPanel {
  #varsJson = null;
  #logged = 0;

  /** @param env {{runner, model, selection}} */
  constructor(host, env) {
    this.host = host;
    this.env = env;
    host.classList.add("sf-debug");
    this.#build();
    // a streamed answer arrives in many chunks; only its text block is patched
    env.runner.addEventListener("stream", () => this.#renderStream());
  }

  #build() {
    this.headEl = el("div", "sf-debug-head");
    this.bodyEl = el("div", "sf-debug-body");
    this.varsEl = el("div", "sf-debug-vars");
    this.logEl = el("div", "sf-debug-log");
    const varsBox = el("div", "sf-debug-col");
    varsBox.append(el("div", "sf-section-title", t("debug.vars")), this.varsEl);
    const logBox = el("div", "sf-debug-col sf-debug-col-log");
    logBox.append(el("div", "sf-section-title", t("debug.events")), this.logEl);

    // the streamed text has a column of its own, so the layout does not jump
    // with each chunk
    this.streamEl = el("div", "sf-debug-stream");
    this.streamBox = el("div", "sf-debug-col sf-debug-col-stream");
    // the title comes from the stage (payload.label), so any stream can be shown
    this.streamTitle = el("div", "sf-section-title", t("debug.stream"));
    this.streamBox.append(this.streamTitle, this.streamEl);
    this.streamBox.hidden = true;

    this.bodyEl.append(varsBox, this.streamBox, logBox);
    // the answer to a run saved at a `wait` node; built when the run waits
    this.answerEl = el("div", "sf-debug-answer");
    this.answerEl.hidden = true;
    this.host.append(this.headEl, this.answerEl, this.bodyEl);
  }

  render() {
    const { runner } = this.env;
    this.host.hidden = runner.status === "idle";
    if (this.host.hidden) {
      this.#varsJson = null;
      this.#logged = 0;
      this.logEl.textContent = "";
      return;
    }
    this.#renderHead();
    this.#renderAnswer();
    this.#renderVars();
    this.#renderStream();
    this.#renderLog();
  }

  /**
   * The streamed text as it arrives: one DOM node is patched per chunk. It
   * stays scrolled to the bottom unless the user has scrolled up to read.
   */
  #renderStream() {
    const { runner } = this.env;
    const text = runner.streamText;
    this.streamBox.hidden = !text;
    if (!text) return;
    const atBottom = this.streamEl.scrollHeight - this.streamEl.scrollTop
      - this.streamEl.clientHeight < 24;
    if (this.streamEl.textContent !== text) this.streamEl.textContent = text;
    this.streamEl.classList.toggle("sf-streaming", Boolean(runner.streaming));
    const label = runner.streamLabel || t("debug.stream");
    this.streamTitle.textContent = runner.streamNode
      ? `${label} · ${runner.streamNode}`
      : label;
    if (atBottom) this.streamEl.scrollTop = this.streamEl.scrollHeight;
  }

  // -------------------------------------------------------------- header

  #renderHead() {
    const { runner } = this.env;
    this.headEl.textContent = "";
    const status = STATUS[runner.status];
    const glyph = status?.glyph ?? "•";
    const text = status ? t(status.key) : runner.status;

    const chip = el("span", `sf-debug-status sf-debug-${runner.status}`);
    chip.append(el("span", "sf-debug-glyph", glyph), el("span", "", text));
    this.headEl.append(chip);

    if (runner.node) {
      const node = el("button", "sf-debug-node", runner.node);
      node.title = t("debug.showNode");
      node.onclick = () => this.env.selection.set({ type: "node", id: runner.node });
      this.headEl.append(node);
    }
    if (runner.error) this.headEl.append(el("span", "sf-debug-error", runner.error));
    for (const chip of this.#meterChips()) this.headEl.append(chip);
    if (runner.status === "finished" && runner.artifacts) {
      const names = Object.keys(runner.artifacts);
      this.headEl.append(el("span", "sf-muted", names.length
        ? t("debug.artifacts", { names: names.join(", ") })
        : t("debug.noArtifacts")));
    }

    this.headEl.append(el("div", "sf-spacer"));

    if (runner.awaitingInput) {
      this.headEl.append(this.#button("⏹", t("debug.stop"), () => runner.stop(),
                                      "sf-btn sf-btn-small sf-danger"));
    } else if (runner.active) {
      this.headEl.append(
        runner.waiting
          ? this.#button("▶", t("debug.resume"), () => runner.resume())
          : this.#button("⏸", t("debug.pause"), () => runner.pause()),
        this.#button("⏭", t("debug.step"), () => runner.step()),
        this.#button("⏹", t("debug.stop"), () => runner.stop(),
                     "sf-btn sf-btn-small sf-danger"),
        this.#delayField(),
      );
    } else {
      this.headEl.append(this.#button("↻", t("debug.rerun"), () => this.env.rerun?.()));
    }
    this.headEl.append(this.#button("✕", t("debug.close"), () => runner.reset()));
  }

  /**
   * What the run has spent, next to what it is allowed. Limited meters come
   * first with their limit; unlimited ones are shown as plain totals.
   */
  #meterChips() {
    const { meters = {}, meterLimits = {} } = this.env.runner;
    const interesting = Object.keys(meters)
      .filter((name) => !name.startsWith("peak_") || name in meterLimits)
      .sort((a, b) => (b in meterLimits) - (a in meterLimits) || a.localeCompare(b));
    return interesting.map((name) => {
      const spent = meters[name];
      const limit = meterLimits[name];
      const shown = Number.isInteger(spent) ? spent : Number(spent).toFixed(2);
      const chip = el("span", "sf-debug-meter");
      chip.append(el("span", "sf-debug-meter-name", name));
      chip.append(el("span", "", limit === undefined ? `${shown}` : `${shown}/${limit}`));
      if (limit !== undefined) {
        const share = limit > 0 ? spent / limit : 1;
        if (share >= 1) chip.classList.add("sf-debug-meter-full");
        else if (share >= 0.8) chip.classList.add("sf-debug-meter-high");
        chip.title = t("debug.meterLimited", { name, spent: shown, limit });
      } else {
        chip.title = t("debug.meterFree", { name, spent: shown });
      }
      return chip;
    });
  }

  #button(label, title, onClick, className = "sf-btn sf-btn-small") {
    const button = el("button", className, label);
    button.title = title;
    button.onclick = onClick;
    return button;
  }

  /** The delay between nodes. It is set on the editor, not only on this run,
   * so the next run keeps the pace (see `Editor.setRunDelay`). */
  #delayField() {
    const wrap = el("label", "sf-debug-delay");
    wrap.append(el("span", "", "delay"));
    const input = el("input");
    input.type = "number";
    input.min = "0";
    input.step = "100";
    input.value = String(Math.round(this.env.runner.delay * 1000));
    input.title = t("debug.delayHint");
    input.onchange = () => {
      const seconds = (Number(input.value) || 0) / 1000;
      if (this.env.setDelay) this.env.setDelay(seconds);
      else this.env.runner.setDelay(seconds);
    };
    wrap.append(input, el("span", "", "ms"));
    return wrap;
  }

  // ---------------------------------------------------------------- answer

  /**
   * The answer to a waiting run: a JSON payload and a button, prefilled with
   * the fields the `wait` node reads (its `outputs`). Built once per wait so a
   * redraw does not discard what is being typed.
   */
  #renderAnswer() {
    const { runner } = this.env;
    const wait = runner.awaiting;
    this.answerEl.hidden = !wait;
    const key = wait ? `${runner.runId}:${wait.node}:${wait.input}` : null;
    if (!wait || this.answerEl.dataset.key === key) return;
    this.answerEl.dataset.key = key;
    this.answerEl.textContent = "";

    const head = el("div", "sf-debug-answer-head");
    head.append(el("span", "", t("debug.awaitingFor", { input: wait.input })));
    if (wait.deadline) {
      head.append(el("span", "sf-muted", t("debug.awaitingUntil", {
        time: new Date(wait.deadline * 1000).toLocaleString(),
      })));
    }
    const payload = el("textarea", "sf-debug-answer-payload");
    payload.spellcheck = false;
    payload.value = JSON.stringify(this.#answerTemplate(wait.node), null, 2);
    payload.rows = Math.min(10, Math.max(3, payload.value.split("\n").length));
    const error = el("span", "sf-debug-error");
    const send = this.#button(t("debug.answer"), t("debug.answerHint", { input: wait.input }),
      async () => {
        let value;
        try {
          value = JSON.parse(payload.value || "{}");
          if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(t("debug.answerObject"));
          }
        } catch (err) {
          error.textContent = err.message;
          return;
        }
        error.textContent = "";
        send.disabled = true;
        try {
          await runner.answer(value);
        } catch (err) {
          error.textContent = err.message;
          send.disabled = false;
        }
      }, "sf-btn sf-btn-small sf-primary");
    this.answerEl.append(head, payload, el("div", "sf-debug-answer-actions"));
    this.answerEl.lastChild.append(send, error);
  }

  /** `{field: ""}` for every payload field the wait node reads. */
  #answerTemplate(nodeId) {
    const node = this.env.model?.pipeline?.nodes?.find((n) => n.id === nodeId);
    const fields = {};
    for (const row of node ? outputRows(node) : []) {
      if (!row.cel) fields[row.src] = "";
      // `output.text` in an expression is an answer field too
      for (const match of row.cel ? row.src.matchAll(/output\.([^\W\d]\w*)/gu) : []) {
        fields[match[1]] ??= "";
      }
    }
    return fields;
  }

  // ------------------------------------------------------------ variables

  #renderVars() {
    const { runner } = this.env;
    // include the status: the frame is editable only while the run is active
    const json = `${runner.active}:${JSON.stringify(runner.vars)}`;
    // do not redraw the table while a value in it is being typed
    if (json === this.#varsJson && this.varsEl.childElementCount) return;
    if (this.host.contains(document.activeElement) && this.varsEl.contains(document.activeElement)) return;
    this.#varsJson = json;
    this.varsEl.textContent = "";

    const names = Object.keys(runner.vars).sort();
    if (!names.length) this.varsEl.append(el("div", "sf-muted", t("debug.emptyFrame")));

    for (const name of names) {
      const secret = this.env.secrets?.has(name) ?? false;
      const row = el("div", `sf-debug-var${secret ? " sf-debug-var-secret" : ""}`);
      row.append(el("span", "sf-debug-var-name", name));
      const input = el("input", "sf-debug-var-value");
      // A secret's value never arrives here: the backend masks it in the
      // events. Its field stays read-only, or an edit would send the mask back
      // and overwrite the key in the live frame
      input.value = secret ? SECRET_MASK : formatLiteral(runner.vars[name]);
      input.disabled = secret || !runner.active;
      input.title = secret
        ? t("debug.varSecret")
        : t("debug.varEditable");
      if (!secret) input.onchange = () => runner.setVar(name, parseLiteral(input.value));
      row.append(input);
      if (runner.active) {
        const drop = el("button", "sf-tag-x", "×");
        drop.title = t("debug.dropVar");
        drop.onclick = () => runner.dropVar(name);
        row.append(drop);
      }
      this.varsEl.append(row);
    }

    if (runner.active) this.varsEl.append(this.#addVarRow());
  }

  #addVarRow() {
    const row = el("div", "sf-debug-var sf-debug-var-new");
    const name = el("input", "sf-debug-var-name");
    name.placeholder = t("debug.varName");
    const value = el("input", "sf-debug-var-value");
    value.placeholder = t("field.result.value");
    const add = el("button", "sf-btn sf-btn-small", "+");
    add.title = t("debug.addVar");
    add.onclick = () => {
      if (!name.value.trim()) return;
      this.env.runner.setVar(name.value.trim(), parseLiteral(value.value));
      name.value = "";
      value.value = "";
    };
    row.append(name, value, add);
    return row;
  }

  // ------------------------------------------------------------------ log

  #renderLog() {
    const { runner } = this.env;
    if (runner.log.length < this.#logged) { // a new run has started
      this.logEl.textContent = "";
      this.#logged = 0;
    }
    for (const event of runner.log.slice(this.#logged)) {
      this.logEl.append(this.#logRow(event));
    }
    this.#logged = runner.log.length;
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  #logRow(event) {
    const row = el("div", `sf-debug-event sf-debug-event-${event.type}`);
    row.append(el("span", "sf-debug-event-type", event.type));
    if (event.node) row.append(el("span", "sf-debug-event-node", event.node));
    const detail = this.#detail(event);
    if (detail) row.append(el("span", "sf-debug-event-detail", detail));
    return row;
  }

  #detail(event) {
    // the backend has already masked the value, but only the editor knows which
    // names are secrets
    if (event.type === "var_set" && this.env.secrets?.has(event.name)) {
      return `${event.name} = ${SECRET_MASK}`;
    }
    if (event.type === "var_set") return `${event.name} = ${formatLiteral(event.value)}`;
    if (event.type === "var_rejected") return `${event.name}: ${event.error}`;
    if (event.type === "var_dropped") return event.name;
    if (event.type === "failed") return event.error;
    if (event.type === "finished") return event.status;
    const payload = event.payload ?? {};
    const keys = Object.keys(payload);
    if (!keys.length) return "";
    return keys.map((key) => `${key}: ${formatLiteral(payload[key])}`).join(", ").slice(0, 120);
  }
}
