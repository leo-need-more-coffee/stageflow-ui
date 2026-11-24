/**
 * A node on the canvas.
 *
 * Its size and the place of every connector come from `nodeLayout` in the
 * core, the same numbers the automatic layout uses, so a laid-out graph never
 * overlaps and the wires meet the card where the layout expected them.
 *
 * Execution runs top to bottom: one inlet on top, the outlets along the
 * bottom, each labelled with its road. Data runs left to right: what a node
 * reads on the left, what it writes on the right.
 */
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { AlertCircle, Check, Hourglass, Loader2, X } from "lucide-react";
import { memo } from "react";

import { varColor } from "@/core/colors.js";
import { DATA_ROW_H, DESC_H, HEAD_H, ORDER_BAR_H, SUB_H } from "@/core/geometry.js";
import { kindOf } from "@/core/kinds.js";
import { cn, Tip } from "@/ui/kit";

import { NodeIcon } from "../kindIcon";

export type RunMark = "current" | "paused" | "visited" | "failed" | "awaiting" | null;

export interface CardData extends Record<string, unknown> {
  node: any;
  layout: any;
  env: any;
  rev: number;
  isEntry: boolean;
  run: RunMark;
  issues: string[];
  marked: boolean;
  dim: boolean;
  highlightVar: string | null;
  labels: { entry: string };
}

export type CardNode = Node<CardData, "card">;

const HEADER_H = HEAD_H + SUB_H;

function RunBadge({ run }: { run: RunMark }) {
  if (!run || run === "visited") {
    return run === "visited"
      ? <span className="flex size-4 items-center justify-center rounded-full bg-accent-soft text-accent"><Check size={11} strokeWidth={3} /></span>
      : null;
  }
  if (run === "failed") return <span className="flex size-4 items-center justify-center rounded-full bg-bad text-white"><X size={11} strokeWidth={3} /></span>;
  if (run === "awaiting") return <Hourglass size={14} className="text-warn" />;
  if (run === "paused") return <span className="size-2 rounded-full bg-warn" />;
  return <Loader2 size={14} className="animate-spin text-accent" />;
}

function DataRow({ label, color, highlighted, mono = true }:
  { label: string; color?: string; highlighted?: boolean; mono?: boolean }) {
  return (
    <div className={cn("flex items-center gap-1.5 truncate px-3 text-[11px] text-muted", mono && "font-mono",
      highlighted && "text-fg")}
      style={{ height: DATA_ROW_H }}>
      {color ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} /> : null}
      <span className="truncate">{label}</span>
    </div>
  );
}

function NodeCardImpl({ data, selected }: NodeProps<CardNode>) {
  const { node, layout, env, run, issues, marked, dim, highlightVar, isEntry, labels } = data;
  const kind = kindOf(node);
  const description = layout.hasDescription ? kind.description(node, env) : "";
  const subtitle = kind.subtitle(node, env);
  const orders = layout.orders as any[];

  const ring = run === "failed" ? "ring-2 ring-bad"
    : run === "awaiting" ? "ring-2 ring-warn"
    : run === "current" || run === "paused" ? "ring-2 ring-accent"
    : selected ? "ring-2 ring-accent/70"
    : marked ? "ring-2 ring-info"
    : issues.length ? "ring-1 ring-bad/50"
    : "";

  return (
    <div
      className={cn(
        "group relative rounded-[10px] border border-border bg-surface shadow-card transition-[opacity,box-shadow]",
        ring, dim && "opacity-45",
      )}
      style={{ width: layout.width, height: layout.height }}
    >
      {/* the inlet: any order edge comes in here */}
      {node.type !== "entry"
        ? <Handle type="target" position={Position.Top} id="in" style={{ left: layout.width / 2 }} />
        : null}

      <div className="flex items-center gap-2.5 px-3" style={{ height: HEADER_H }}>
        <NodeIcon node={node} env={env} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-[12.5px] font-medium text-fg">{node.id}</span>
            {isEntry && node.type !== "entry"
              ? <span className="rounded bg-surface-2 px-1 text-[10px] font-medium text-muted">{labels.entry}</span>
              : null}
          </div>
          <div className="truncate text-[11.5px] text-muted">{subtitle}</div>
        </div>
        {issues.length
          ? (
            <Tip content={issues.join("\n")} side="top">
              <AlertCircle size={15} className="shrink-0 text-bad" />
            </Tip>
          )
          : null}
        <RunBadge run={run} />
      </div>

      {description
        ? (
          <div className="line-clamp-2 px-3 text-[11px] leading-[14px] text-subtle" style={{ height: DESC_H }}>
            {description}
          </div>
        )
        : null}

      {layout.ins.map((port: any, i: number) => {
        const name = port.refs?.[0]?.name;
        return (
          <div key={`in${i}`} className="relative">
            <DataRow label={port.label} color={name ? varColor(name) : undefined}
              highlighted={Boolean(highlightVar && port.refs?.some((r: any) => r.name === highlightVar))} />
            <Handle type="target" position={Position.Left} id={`din${i}`} isConnectable={false}
              className="!size-1.5 !border-0" style={{ top: DATA_ROW_H / 2, background: name ? varColor(name) : undefined }} />
          </div>
        );
      })}
      {layout.values.map((row: any, i: number) => (
        <div key={`v${i}`} className="flex items-center gap-1.5 truncate px-3 font-mono text-[11px]" style={{ height: DATA_ROW_H }}>
          <span className="text-muted">{row.name}</span>
          <span className="text-subtle">=</span>
          <span className="truncate text-fg/80">{row.text}</span>
        </div>
      ))}
      {layout.outs.map((port: any, j: number) => {
        const name = port.variable?.name;
        return (
          <div key={`out${j}`} className="relative">
            <div className="flex justify-end">
              <DataRow label={port.label} color={name ? varColor(name) : undefined}
                highlighted={highlightVar === name} />
            </div>
            <Handle type="source" position={Position.Right} id={`dout${j}`} isConnectable={false}
              className="!size-1.5 !border-0" style={{ top: DATA_ROW_H / 2, background: name ? varColor(name) : undefined }} />
          </div>
        );
      })}

      {orders.length
        ? (
          <div className="absolute inset-x-0 bottom-0 flex border-t border-border" style={{ height: ORDER_BAR_H }}>
            {orders.map((port, k) => (
              <div key={k} className="relative flex min-w-0 flex-1 items-center justify-center px-1">
                <span className={cn("truncate text-[10.5px] font-medium",
                  port.add ? "text-subtle" : port.get?.() ? "text-muted" : "text-subtle")}>
                  {port.label}
                </span>
                <Handle type="source" position={Position.Bottom} id={`o${k}`}
                  className={cn(port.dashed && "!bg-transparent !border-edge !border-dashed", port.add && "!bg-surface !border-edge")}
                  style={{ left: "50%" }} />
              </div>
            ))}
          </div>
        )
        : null}
    </div>
  );
}

export const NodeCard = memo(NodeCardImpl, (a, b) =>
  a.data.rev === b.data.rev && a.selected === b.selected && a.data.run === b.data.run
  && a.data.dim === b.data.dim && a.data.marked === b.data.marked
  && a.data.highlightVar === b.data.highlightVar && a.data.layout === b.data.layout);

/** A block's frame: the body of a try, a loop or a parallel branch. */
export interface RegionData extends Record<string, unknown> {
  title: string;
  color: string;
}

export type RegionNode = Node<RegionData, "region">;

export function RegionFrame({ data }: NodeProps<RegionNode>) {
  return (
    <div className="pointer-events-none size-full rounded-xl border border-dashed"
      style={{
        borderColor: `color-mix(in oklab, ${data.color} 45%, transparent)`,
        background: `color-mix(in oklab, ${data.color} 5%, transparent)`,
      }}>
      <div className="px-3 pt-1.5 font-mono text-[11px] font-medium"
        style={{ color: `color-mix(in oklab, ${data.color} 80%, var(--fg))` }}>
        {data.title}
      </div>
    </div>
  );
}
