/**
 * How a node is recognised at a glance: a small tile in its kind's colour
 * with an icon. A stage shows its own icon from the backend when it has one,
 * otherwise a monogram of its name, so two stages are still told apart.
 */
import {
  Box, CircleStop, GitBranch, GitFork, Hourglass, Layers, Play, Repeat, ShieldAlert, Split,
  type LucideIcon,
} from "lucide-react";

import { resolveIcon } from "@/core/icons.js";
import { kindOf } from "@/core/kinds.js";
import { cn } from "@/ui/kit";

export const KIND_ICONS: Record<string, LucideIcon> = {
  entry: Play,
  stage: Box,
  condition: Split,
  switch: GitFork,
  parallel: GitBranch,
  subpipeline: Layers,
  terminal: CircleStop,
  try: ShieldAlert,
  map: Repeat,
  wait: Hourglass,
};

/** The tile colours from a kind's accent: a tint behind, the hue on the icon. */
export function tileStyle(color: string) {
  return {
    background: `color-mix(in oklab, ${color} 16%, transparent)`,
    color: `color-mix(in oklab, ${color} 82%, var(--fg))`,
  };
}

export function KindIcon({ type, color, size = 24, className }:
  { type: string; color?: string; size?: number; className?: string }) {
  const Icon = KIND_ICONS[type] ?? Box;
  const accent = color ?? kindOf({ type }).color;
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-md", className)}
      style={{ width: size, height: size, ...tileStyle(accent) }}>
      <Icon size={Math.round(size * 0.58)} strokeWidth={2} />
    </span>
  );
}

/** The tile of a node as it is configured: a stage's own icon when it has one. */
export function NodeIcon({ node, env, size = 28, className }:
  { node: any; env: any; size?: number; className?: string }) {
  const kind = kindOf(node);
  const color = kind.accent(node, env);
  if (node.type !== "stage") return <KindIcon type={node.type} color={color} size={size} className={className} />;
  const icon = resolveIcon(env?.stages?.get(node.stage)?.icon, env?.backend?.url ?? "");
  const style = { width: size, height: size, ...tileStyle(color) };
  const box = cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md", className);
  if (icon?.type === "url") {
    if (kind.iconMono(node, env)) {
      return (
        <span className={box} style={style}>
          <span style={{
            width: size * 0.6, height: size * 0.6, background: "currentColor",
            mask: `url("${icon.value}") center / contain no-repeat`,
            WebkitMask: `url("${icon.value}") center / contain no-repeat`,
          }} />
        </span>
      );
    }
    return <span className={box} style={style}><img src={icon.value} alt="" className="size-[62%] object-contain" /></span>;
  }
  const text = icon?.value ?? kind.iconFallback(node, env);
  return (
    <span className={cn(box, "font-semibold")} style={{ ...style, fontSize: size * (text.length > 1 ? 0.36 : 0.5) }}>
      {text}
    </span>
  );
}
