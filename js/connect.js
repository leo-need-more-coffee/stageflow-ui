/**
 * The connection screen: which backend this editor talks to.
 *
 * The editor has no stages and runs nothing (see `backend.js`), so it asks for
 * the address before showing the canvas; an empty palette would look broken.
 *
 * The address is checked with `GET /api/stages`, the request the editor needs
 * anyway, so "connected" means the backend answers and allows this origin. A
 * working address is remembered.
 *
 * The screen also takes a credential header, name and value, since backends
 * differ in what they call it. The editor only sends it; a wrong one shows up
 * here, by the same check, rather than at the first run.
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
 * Credentials by backend address, so a token is only ever sent to the backend
 * it was typed for (a `?backend=` link to another address does not get it).
 * An older single remembered `auth` is read as belonging to its `url`.
 */
function credentialsOf(saved) {
  const out = {};
  const put = (url, auth) => {
    const address = normalizeBackendUrl(url ?? "");
    if (!address || typeof auth?.value !== "string" || !auth.value) return;
    out[address] = {
      header: typeof auth.header === "string" && auth.header.trim()
        ? auth.header.trim() : DEFAULT_AUTH_HEADER,
      value: auth.value,
    };
  };
  if (saved.auth) put(saved.url, saved.auth);
  for (const [url, auth] of Object.entries(saved.credentials ?? {})) put(url, auth);
  return out;
}

/**
 * What was remembered: the last backend that answered, the plan being viewed,
 * and the credential for `url` (or for that last address if none is given).
 *
 * The credential is kept in `localStorage` with the same caveat as secrets
 * (see `secrets.js`): it keeps tokens out of exports and screenshots, it is
 * not encryption. Asking on every reload would only push people to paste
 * tokens into the graph.
 */
export function storedBackend(storageKey, url = undefined) {
  const saved = readJson(backendStorageKey(storageKey)) ?? {};
  const last = normalizeBackendUrl(saved.url ?? "");
  const address = url === undefined ? last : normalizeBackendUrl(url ?? "");
  return {
    url: last,
    auth: credentialsOf(saved)[address] ?? { header: DEFAULT_AUTH_HEADER, value: "" },
    plan: typeof saved.plan === "string" && saved.plan ? saved.plan : null,
  };
}

/** Remember a backend; the one place that writes this record. */
export function rememberBackend(storageKey, { url, auth, plan }) {
  const key = backendStorageKey(storageKey);
  if (!key) return;
  const saved = readJson(key) ?? {};
  const credentials = credentialsOf(saved);
  const address = normalizeBackendUrl(url ?? "");
  if (address) {
    if (auth?.value) credentials[address] = { header: auth.header || DEFAULT_AUTH_HEADER,
                                              value: auth.value };
    else delete credentials[address];
  }
  writeJson(key, { url: address, credentials, plan: plan ?? null });
}

/**
 * Ask for the backend and return it once it has answered.
 *
 * @param storageKey where to remember it (the editor's storage key)
 * @param url        an address to try first (an option or query parameter);
 *                   `""` asks right away
 * @param plan       the plan to view (`?plan=` on the editor's URL)
 * @param force      show the screen even if the remembered address works
 *                   ("change backend" in the menu)
 * @param onCancel   makes the screen cancellable; without it there is nothing
 *                   to go back to
 * @returns {Promise<Backend|null>} null only if a cancellable screen was cancelled
 */
export function connectBackend({
  storageKey = null, url = null, plan = null, force = false, onCancel = null,
} = {}) {
  const remembered = storedBackend(storageKey);
  const first = normalizeBackendUrl(url ?? "") || (force ? "" : remembered.url);
  const shownPlan = plan ?? remembered.plan;
  // only ever the credential stored for this address
  const credentialFor = (address) => storedBackend(storageKey, address).auth;
  const initial = credentialFor(first || remembered.url);

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

    // The credential section is folded, since most backends need none, but
    // open when one is stored, so a token that stopped working is visible
    const auth = el("details", "sf-connect-auth");
    auth.open = Boolean(initial.value);
    const summary = el("summary", "", t("conn.auth"));
    summary.append(el("span", "sf-connect-auth-hint",
      t(initial.value ? "connect.auth.set" : "connect.auth.optional")));
    auth.append(summary);

    const authRow = el("div", "sf-connect-auth-row");
    const headerInput = el("input", "sf-connect-input sf-connect-header");
    headerInput.type = "text";
    headerInput.name = "auth-header";
    headerInput.spellcheck = false;
    headerInput.autocomplete = "off";
    headerInput.placeholder = DEFAULT_AUTH_HEADER;
    headerInput.value = initial.header;
    const valueInput = el("input", "sf-connect-input");
    // a password field keeps the token off screen during a demo; pasting works
    valueInput.type = "password";
    valueInput.name = "auth-value";
    valueInput.spellcheck = false;
    valueInput.autocomplete = "off";
    valueInput.placeholder = "Bearer …";
    valueInput.value = initial.value;
    authRow.append(headerInput, valueInput);
    auth.append(authRow);
    auth.append(el("p", "sf-connect-auth-note", t("connect.auth.note")));
    box.append(auth);

    const status = el("div", "sf-connect-status");
    status.hidden = true;
    box.append(status);

    const note = el("div", "sf-connect-note");
    // one sentence with a command and a link: `pieces` keeps it one entry so a
    // translation can order the parts
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
        // a remembered address that stopped answering is not the user's
        // mistake, so say it plainly
        say(silent
          ? t("connect.silentFail", { address, reason: err.message })
          : t("connect.fail", { address, reason: err.message }), "bad");
        // a refused credential can be fixed here: open its section
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

    // the credential fields follow the address until the user types into them
    let typedCredential = false;
    headerInput.addEventListener("input", () => { typedCredential = true; });
    valueInput.addEventListener("input", () => { typedCredential = true; });
    input.addEventListener("input", () => {
      if (typedCredential) return;
      const known = credentialFor(input.value);
      headerInput.value = known.header;
      valueInput.value = known.value;
    });

    if (first) attempt(first, { silent: true });
    else input.focus();
  });
}
