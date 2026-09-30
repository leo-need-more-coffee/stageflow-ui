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
 *
 * A backend serving more than one tenant wants to know who is calling, so the
 * screen also takes a header — NAME and value both, because the editor has no
 * business deciding that a credential is called `Authorization` and looks like
 * `Bearer …`. It authenticates nothing itself: it carries what it is given and
 * reports what came back. The check is the same request, so a credential that
 * is wrong is wrong here, on the screen where it can be corrected, rather than
 * at the first run.
 */
import { pieces, t, tn } from "./i18n.js";
import { VERSION } from "./version.js";
import {
  Backend, DEFAULT_AUTH_HEADER, backendStorageKey, normalizeBackendUrl,
} from "./backend.js";
import { readJson, writeJson } from "./storage.js";

const EXAMPLE_URL = "http://127.0.0.1:8765";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * What was remembered about the last backend that answered: the address, the
 * credential and which plan was being looked at.
 *
 * The credential goes into `localStorage` beside the editor's other secrets
 * and with the same caveat as those (see `secrets.js`): it is not encryption,
 * it protects against a token spreading through exported files and
 * screenshots, not against someone at the keyboard. The alternative — asking
 * for it on every reload — is what makes people paste tokens into the graph.
 */
export function storedBackend(storageKey) {
  const saved = readJson(backendStorageKey(storageKey)) ?? {};
  return {
    url: normalizeBackendUrl(saved.url ?? ""),
    auth: {
      header: typeof saved.auth?.header === "string" && saved.auth.header.trim()
        ? saved.auth.header.trim() : DEFAULT_AUTH_HEADER,
      value: typeof saved.auth?.value === "string" ? saved.auth.value : "",
    },
    plan: typeof saved.plan === "string" && saved.plan ? saved.plan : null,
  };
}

/** What the editor remembers about a backend; one writer, one shape. */
export function rememberBackend(storageKey, { url, auth, plan }) {
  const key = backendStorageKey(storageKey);
  if (key) writeJson(key, { url, auth, plan: plan ?? null });
}

/**
 * Asks for the backend and returns it once it has answered.
 *
 * @param storageKey where to remember the address (the editor's session key)
 * @param url        an address to try before asking (an option, a query
 *                   parameter); `""` means "ask right away"
 * @param plan       which plan to be shown (`?plan=` on the editor's own URL)
 * @param force      show the screen even if the remembered address answers —
 *                   that is "change the backend" from the menu
 * @param onCancel   makes the screen cancellable (the menu, where there is
 *                   something to go back to); without it there is no way out,
 *                   because there is nothing behind the screen yet
 * @returns {Promise<Backend|null>} null only when a cancellable screen was cancelled
 */
export function connectBackend({
  storageKey = null, url = null, plan = null, force = false, onCancel = null,
} = {}) {
  const remembered = storedBackend(storageKey);
  const first = normalizeBackendUrl(url ?? "") || (force ? "" : remembered.url);
  const shownPlan = plan ?? remembered.plan;

  return new Promise((resolve) => {
    const overlay = el("div", "sf-connect-overlay");
    const box = el("div", "sf-connect");
    const form = el("form", "sf-connect-form");

    box.append(el("div", "sf-connect-mark", "◇"));
    const title = el("h1", "sf-connect-title", "StageFlow Editor");
    title.append(el("span", "sf-connect-version", `v${VERSION}`));
    box.append(title);
    box.append(el("p", "sf-connect-lead", t("connect.lead")));

    const input = el("input", "sf-connect-input");
    input.type = "text";
    input.name = "backend";
    input.placeholder = EXAMPLE_URL;
    input.spellcheck = false;
    input.autocomplete = "url";
    input.value = first || "";

    const button = el("button", "sf-btn sf-primary sf-connect-btn", t("connect.go"));
    button.type = "submit";
    form.append(input, button);
    box.append(form);

    // The credential, folded away: most backends want none, and a field
    // demanding one on the first screen reads as "you need an account".
    // Folded OPEN when there already is one, so that a token that stopped
    // working is visible where it is corrected rather than hidden behind a
    // triangle.
    const auth = el("details", "sf-connect-auth");
    auth.open = Boolean(remembered.auth.value);
    const summary = el("summary", "", t("conn.auth"));
    summary.append(el("span", "sf-connect-auth-hint",
      t(remembered.auth.value ? "connect.auth.set" : "connect.auth.optional")));
    auth.append(summary);

    const authRow = el("div", "sf-connect-auth-row");
    const headerInput = el("input", "sf-connect-input sf-connect-header");
    headerInput.type = "text";
    headerInput.name = "auth-header";
    headerInput.spellcheck = false;
    headerInput.autocomplete = "off";
    headerInput.placeholder = DEFAULT_AUTH_HEADER;
    headerInput.value = remembered.auth.header;
    const valueInput = el("input", "sf-connect-input");
    // a password field so that a token is not on screen in a demonstration;
    // pasting into one works, and reading it back is not what it is for
    valueInput.type = "password";
    valueInput.name = "auth-value";
    valueInput.spellcheck = false;
    valueInput.autocomplete = "off";
    valueInput.placeholder = "Bearer …";
    valueInput.value = remembered.auth.value;
    authRow.append(headerInput, valueInput);
    auth.append(authRow);
    auth.append(el("p", "sf-connect-auth-note", t("connect.auth.note")));
    box.append(auth);

    const status = el("div", "sf-connect-status");
    status.hidden = true;
    box.append(status);

    const note = el("div", "sf-connect-note");
    // one sentence with a command and a link inside it: `pieces` keeps it one
    // entry, so a translation can put them where its own grammar wants them
    const inside = {
      command: () => el("code", "", "python main.py"),
      repo: () => Object.assign(el("a", "", "stageflow-example"), {
        href: "https://github.com/leo-need-more-coffee/stageflow-example",
        target: "_blank", rel: "noreferrer noopener",
      }),
    };
    for (const piece of pieces("connect.none", ["command", "repo"], { url: EXAMPLE_URL })) {
      note.append(typeof piece === "string" ? el("span", "", piece) : inside[piece.slot]());
    }
    box.append(note);

    if (onCancel) {
      const cancel = el("button", "sf-btn sf-connect-cancel", t("common.cancel"));
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
        say(t("connect.badAddress"), "bad");
        input.focus();
        return;
      }
      const credential = { header: headerInput.value.trim() || DEFAULT_AUTH_HEADER,
                           value: valueInput.value.trim() };
      busy = true;
      button.disabled = true;
      input.disabled = true;
      say(t("connect.connecting", { address }), "wait");
      try {
        const backend = new Backend(address, { auth: credential, plan: shownPlan });
        const { count } = await backend.probe();
        rememberBackend(storageKey, { url: backend.url, auth: backend.auth,
                                      plan: backend.plan });
        say(tn("connect.connected", count), "ok");
        overlay.remove();
        resolve(backend);
        return;
      } catch (err) {
        // a remembered address that stopped answering is not an error of the
        // user's making, so the first, silent attempt says it plainly
        say(silent
          ? t("connect.silentFail", { address, reason: err.message })
          : t("connect.fail", { address, reason: err.message }), "bad");
        // a refusal is the one failure with a cure on this screen: unfold the
        // field rather than leave the answer behind a triangle
        if (/credential|HTTP 40[13]/i.test(err.message)) {
          auth.open = true;
          valueInput.focus();
        }
      } finally {
        busy = false;
        button.disabled = false;
        input.disabled = false;
      }
      if (!auth.open) {
        input.focus();
        input.select();
      }
    };

    form.onsubmit = (e) => {
      e.preventDefault();
      attempt(input.value);
    };

    if (first) attempt(first, { silent: true });
    else input.focus();
  });
}
