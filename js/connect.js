/**
 * The connection screen: which backend this editor talks to.
 *
 * The editor is static front-end — it holds no stage registry and executes
 * nothing (see `backend.js`). So the first question it has to ask is the
 * address, and it has to ask it before the canvas appears: an editor with an
 * empty palette and a dead "Run" would look broken rather than unconfigured.
 *
 * The address is checked by the very request the editor cannot work without
 * (`GET /api/stages`), so "connected" means the thing really answers and
 * really allows this origin — not that the string looks like a URL. A checked
 * address is remembered, so the question is asked once rather than on every
 * reload.
 */
import { Backend, backendStorageKey, normalizeBackendUrl } from "./backend.js";
import { readJson, writeJson } from "./storage.js";

const EXAMPLE_URL = "http://127.0.0.1:8765";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The address of the last backend that answered, or "". */
export function storedBackendUrl(storageKey) {
  const saved = readJson(backendStorageKey(storageKey));
  return normalizeBackendUrl(saved?.url ?? "");
}

function rememberBackendUrl(storageKey, url) {
  const key = backendStorageKey(storageKey);
  if (key) writeJson(key, { url });
}

/**
 * Asks for the backend and returns it once it has answered.
 *
 * @param storageKey where to remember the address (the editor's session key)
 * @param url        an address to try before asking (an option, a query
 *                   parameter); `""` means "ask right away"
 * @param force      show the screen even if the remembered address answers —
 *                   that is "change the backend" from the menu
 * @param onCancel   makes the screen cancellable (the menu, where there is
 *                   something to go back to); without it there is no way out,
 *                   because there is nothing behind the screen yet
 * @returns {Promise<Backend|null>} null only when a cancellable screen was cancelled
 */
export function connectBackend({
  storageKey = null, url = null, force = false, onCancel = null,
} = {}) {
  const first = normalizeBackendUrl(url ?? "") || (force ? "" : storedBackendUrl(storageKey));

  return new Promise((resolve) => {
    const overlay = el("div", "sf-connect-overlay");
    const box = el("div", "sf-connect");
    const form = el("form", "sf-connect-form");

    box.append(el("div", "sf-connect-mark", "◇"));
    box.append(el("h1", "sf-connect-title", "StageFlow Editor"));
    box.append(el("p", "sf-connect-lead",
      "The editor draws and debugs pipelines, but the stages and the execution "
      + "live on a StageFlow backend. Give it the address of one."));

    const input = el("input", "sf-connect-input");
    input.type = "text";
    input.name = "backend";
    input.placeholder = EXAMPLE_URL;
    input.spellcheck = false;
    input.autocomplete = "url";
    input.value = first || "";

    const button = el("button", "sf-btn sf-primary sf-connect-btn", "Connect");
    button.type = "submit";
    form.append(input, button);
    box.append(form);

    const status = el("div", "sf-connect-status");
    status.hidden = true;
    box.append(status);

    const note = el("div", "sf-connect-note");
    note.append(
      el("span", "", "No backend at hand? "),
      el("code", "", "python serve.py"),
      el("span", "", " from "),
      Object.assign(el("a", "", "stageflow-example"), {
        href: "https://github.com/leo-need-more-coffee/stageflow-example",
        target: "_blank", rel: "noreferrer noopener",
      }),
      el("span", "", ` serves one at ${EXAMPLE_URL}.`),
    );
    box.append(note);

    if (onCancel) {
      const cancel = el("button", "sf-btn sf-connect-cancel", "Cancel");
      cancel.type = "button";
      cancel.onclick = () => { overlay.remove(); onCancel(); resolve(null); };
      box.append(cancel);
    }

    overlay.append(box);
    document.body.append(overlay);

    const say = (text, kind) => {
      status.textContent = text;
      status.className = `sf-connect-status sf-connect-${kind}`;
      status.hidden = !text;
    };

    let busy = false;
    const attempt = async (raw, { silent = false } = {}) => {
      if (busy) return;
      const address = normalizeBackendUrl(raw);
      if (!address) {
        say("That does not look like an address. Try http://host:port.", "bad");
        input.focus();
        return;
      }
      busy = true;
      button.disabled = true;
      input.disabled = true;
      say(`Connecting to ${address}…`, "wait");
      try {
        const backend = new Backend(address);
        const { count } = await backend.probe();
        rememberBackendUrl(storageKey, backend.url);
        say(`Connected: ${count} stages.`, "ok");
        overlay.remove();
        resolve(backend);
        return;
      } catch (err) {
        // a remembered address that stopped answering is not an error of the
        // user's making, so the first, silent attempt says it plainly
        say(silent
          ? `${address} — ${err.message}. Check the address or start the backend.`
          : `${address} — ${err.message}`, "bad");
      } finally {
        busy = false;
        button.disabled = false;
        input.disabled = false;
      }
      input.focus();
      input.select();
    };

    form.onsubmit = (e) => {
      e.preventDefault();
      attempt(input.value);
    };

    if (first) attempt(first, { silent: true });
    else input.focus();
  });
}
