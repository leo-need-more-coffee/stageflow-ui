/**
 * Which backend the editor talks to, remembered between visits.
 *
 * The editor has no stages and runs nothing itself (see `backend.js`), so the
 * first screen asks for an address. The address is checked with
 * `GET /api/stages`, the request the editor needs anyway, so "connected" means
 * the backend answers and allows this origin. A working address is remembered,
 * with its credential, and a credential is only ever sent to the address it
 * was typed for.
 *
 * The screen itself is a component; this module is what it decides with.
 */
import {
  Backend, DEFAULT_AUTH_HEADER, backendStorageKey, normalizeBackendUrl,
} from "./backend.js";
import { readJson, writeJson } from "./storage.js";

export const EXAMPLE_URL = "http://127.0.0.1:8765";

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
 * Where the connection screen starts: the address to try at once, the plan to
 * view, and the credential for that address only. A `?backend=` link to
 * another address gets no credential, so opening a link never sends a token
 * to whoever wrote it.
 */
export function initialConnection({ storageKey = null, url = null, plan = null, force = false } = {}) {
  const remembered = storedBackend(storageKey);
  const first = normalizeBackendUrl(url ?? "") || (force ? "" : remembered.url);
  return {
    url: first,
    plan: plan ?? remembered.plan,
    auth: storedBackend(storageKey, first || remembered.url).auth,
  };
}

/** The credential remembered for an address, for fields that follow typing. */
export function credentialFor(storageKey, address) {
  return storedBackend(storageKey, address).auth;
}

/**
 * Try a backend; on success remember it and return it, otherwise throw with
 * the reason. A refused credential throws an error with `credential: true`,
 * so the screen can open the credential fields.
 */
export async function attemptConnection(storageKey, raw, auth, plan = null) {
  const address = normalizeBackendUrl(raw ?? "");
  if (!address) throw Object.assign(new Error("bad address"), { badAddress: true });
  const credential = { header: auth?.header?.trim() || DEFAULT_AUTH_HEADER,
                       value: auth?.value?.trim() ?? "" };
  const backend = new Backend(address, { auth: credential, plan });
  try {
    const { count } = await backend.probe();
    rememberBackend(storageKey, { url: backend.url, auth: backend.auth, plan: backend.plan });
    return { backend, count };
  } catch (err) {
    if (/credential|HTTP 40[13]/i.test(err.message)) err.credential = true;
    err.address = address;
    throw err;
  }
}
