import { watch } from "node:fs";
import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The catalogs are fetched once when the page opens, so a module reload does
 * not pick up a new string. In development an edited catalog reloads the page.
 */
function reloadOnCatalog(): Plugin {
  return {
    name: "stageflow-reload-on-catalog",
    configureServer(server) {
      // Vite's own watcher leaves the public directory alone, so this one
      // watches the catalogs itself
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watcher = watch(fileURLToPath(new URL("./public/i18n", import.meta.url)), (_, name) => {
        if (!String(name).endsWith(".json")) return;
        clearTimeout(timer);
        timer = setTimeout(() => server.ws.send({ type: "full-reload" }), 100);
      });
      server.httpServer?.on("close", () => watcher.close());
    },
  };
}

// `base: "./"` keeps every asset path relative, so the same build works at the
// root of a server and under a GitHub Pages project path.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), reloadOnCatalog()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { port: 5173, host: "127.0.0.1" },
  build: { outDir: "dist", sourcemap: true },
});
