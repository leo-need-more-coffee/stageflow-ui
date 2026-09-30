/**
 * The debug panel: where we stand, what we control, what is in the frame and
 * what happened.
 *
 * A separate panel at the bottom rather than an inspector tab: during debugging
 * the graph (which node is executing), the variables and the step buttons are
 * needed AT THE SAME TIME. The inspector meanwhile goes on showing the node
 * being looked at — debugging must not take its room away.
 *
 * The panel is updated on every run event, so it is built once and patched in
 * pieces afterwards: redrawing it whole would tear out the field in which a
 * variable value is being typed at that very moment.
 */
import { t } from "./i18n.js";
import { formatLiteral, parseLiteral } from "./kinds.js";
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
    // the answer stream arrives in chunks, a hundred per answer: the panel
    // patches ONLY its own text block, touching neither the variable table nor
    // the log
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

    // The model answer gets a column of its own: it is written chunk by chunk,
    // and the room for it must be permanent, or the panel would twitch on every
    // token
    this.streamEl = el("div", "sf-debug-stream");
    this.streamBox = el("div", "sf-debug-col sf-debug-col-stream");
    // the heading is set by the stage (payload.label): the panel does not know
    // what text it was sent — it can show any stream
    this.streamTitle = el("div", "sf-section-title", t("debug.stream"));
    this.streamBox.append(this.streamTitle, this.streamEl);
    this.streamBox.hidden = true;

    this.bodyEl.append(varsBox, this.streamBox, logBox);
    this.host.append(this.headEl, this.bodyEl);
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
    this.#renderVars();
    this.#renderStream();
    this.#renderLog();
  }

  /**
   * The answer text as it is being written.
   *
   * A patch of one DOM node rather than a redraw: there are hundreds of chunks.
   * The scroll sticks to the bottom — but only if the user has not scrolled it
   * back themselves: reading the middle of an answer that keeps running away
   * downwards is impossible.
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

    if (runner.active) {
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
   * What the run has spent, next to what it is allowed.
   *
   * A ceiling nobody can see is a ceiling you find out about by hitting it,
   * which is the one moment it is no use. Limited meters come first and
   * carry their allowance; the rest are shown as plain totals, because a
   * meter nobody limits is still what the bill is made of.
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

  /** The delay between nodes: "watch it go" without stepping by hand. It goes
   * into the editor rather than straight into the run: the next run starts at
   * the same pace (see `Editor.setRunDelay`). */
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

  // ------------------------------------------------------------ variables

  #renderVars() {
    const { runner } = this.env;
    const json = JSON.stringify(runner.vars);
    // do not touch the table while something is being typed into it: the events
    // come in a stream, and a redraw would throw the field out along with what
    // was typed
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
      // The value of a secret does not arrive here at all: the backend
      // replaces it in the events with a mask. The field stays
      // closed even during a run — otherwise an edit would send the dots back
      // and wipe the key in the live frame
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
    // the server has already scrubbed the values, but only the editor knows the
    // name of a secret: the log shows WHAT happened without revealing with what
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
