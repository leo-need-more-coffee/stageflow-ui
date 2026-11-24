/**
 * The editor as a library, for a page that embeds it.
 *
 *   import { connectBackend, createEditor } from "stageflow-ui";
 *
 *   const backend = await connectBackend(document.body, { storageKey: "my-app" });
 *   const editor = createEditor(container, { backend, storageKey: "my-app" });
 *   editor.getPipeline();
 *   editor.addEventListener("change", () => save(editor.getPipeline()));
 *
 * `createEditor` returns the same `Editor` the interface drives, so anything
 * the interface can do, the embedding page can do too.
 */
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { ConnectScreen } from "./app/connect/ConnectScreen";
import { Editor, type EditorOptions } from "./app/editor";
import "./styles.css";

export { Editor } from "./app/editor";
export type { EditorOptions } from "./app/editor";

export function createEditor(container: HTMLElement, options: EditorOptions) {
  const editor = new Editor(options);
  const root = createRoot(container);
  root.render(<App editor={editor} />);
  (editor as any).unmount = () => root.unmount();
  return editor;
}

/**
 * Ask for the backend address on a screen of its own, and resolve with the
 * backend once it answers. A remembered address is tried first.
 */
export function connectBackend(container: HTMLElement, options: {
  storageKey?: string | null; url?: string | null; plan?: string | null;
} = {}): Promise<any> {
  return new Promise((resolve) => {
    const root = createRoot(container);
    root.render(
      <ConnectScreen storageKey={options.storageKey ?? null} url={options.url ?? null} plan={options.plan ?? null}
        onConnected={(backend) => {
          root.unmount();
          resolve(backend);
        }} />,
    );
  });
}
