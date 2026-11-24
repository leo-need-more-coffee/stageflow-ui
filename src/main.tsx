/**
 * The page: the language, then the backend, then the editor.
 *
 * `?backend=http://host:port` skips the question (a bookmark, a demo); the
 * address is remembered either way. `?plan=basic` draws the editor as that
 * plan sees it; it never changes what a run is allowed, which the backend
 * decides from the credential.
 *
 * `?bridge=http://127.0.0.1:7433#bridge-token=…` connects an agent working on
 * this graph from outside (stageflow-mcp --bridge). The token is in the
 * fragment on purpose: a query parameter would end up in server logs and in
 * every Referer.
 */
import { connectBridge } from "./core/bridge.js";
import { loadLocale, t } from "./core/i18n.js";
import { connectBackend, createEditor } from "./lib";

const storageKey = "stageflow-editor";
const root = document.getElementById("root")!;

await loadLocale();

const query = new URLSearchParams(location.search);
const backend = await connectBackend(root, { storageKey, url: query.get("backend"), plan: query.get("plan") });
const editor = createEditor(root, { backend, storageKey });
(window as any).editor = editor;

// "+2 −1 ✎3": only the parts that are not zero
const counts = () => {
  const change = editor.lastChange;
  if (!change) return "";
  return ([["+", change.added.length], ["−", change.removed.length], ["✎", change.changed.length]] as [string, number][])
    .filter(([, n]) => n).map(([sign, n]) => `${sign}${n}`).join(" ");
};

void connectBridge(editor, {
  onState: (state: string, detail: string | null) => {
    const said: Record<string, () => [string, string, (() => void) | null]> = {
      connecting: () => [t("bridge.connecting"), t("bridge.about"), null],
      live: () => [detail ? t("bridge.did", { note: detail }) : t("bridge.live"),
        [detail, t("bridge.about")].filter(Boolean).join("\n\n"), null],
      lost: () => [t("bridge.lost"),
        [detail === "local-network" ? t("bridge.localNetwork") : detail, t("bridge.retry")].filter(Boolean).join("\n"),
        () => (window as any).bridge?.reconnect()],
    };
    const [text, title, act] = said[state]?.() ?? ["", "", null];
    editor.setStatusNote("bridge", text, title, act);
    editor.setStatusNote("diff", state === "live" ? counts() : "", t("bridge.counts"));
  },
}).then((bridge: any) => { if (bridge) (window as any).bridge = bridge; });
