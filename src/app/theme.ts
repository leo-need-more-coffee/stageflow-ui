/**
 * Light, dark, or whatever the system says. The choice is remembered; the
 * class on <html> is also set by a script in index.html before the first
 * paint, so a dark page never flashes white.
 */
import { useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "stageflow-editor:theme";
const listeners = new Set<() => void>();
const media = matchMedia("(prefers-color-scheme: dark)");

function read(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

let choice: ThemeChoice = read();

function apply() {
  const dark = choice === "dark" || (choice === "system" && media.matches);
  document.documentElement.classList.toggle("dark", dark);
  for (const notify of listeners) notify();
}

media.addEventListener("change", () => { if (choice === "system") apply(); });

export function setTheme(next: ThemeChoice) {
  choice = next;
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch { /* nowhere to remember it; it still applies now */ }
  apply();
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore((notify) => {
    listeners.add(notify);
    return () => listeners.delete(notify);
  }, () => choice);
}

/** Whether the page is dark right now, whatever the choice. */
export function useIsDark(): boolean {
  useTheme();
  return document.documentElement.classList.contains("dark");
}

apply();
