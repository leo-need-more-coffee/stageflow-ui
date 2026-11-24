/**
 * The two kinds of wire.
 *
 * An order edge is where execution goes next. It is drawn by the core's
 * `orderEdgePath`, which takes it around a block it skips (a loop's `next`
 * past the loop body) instead of behind the body's cards. Hovering it offers
 * a "+" to insert a node into it.
 *
 * A data edge is a variable going from the node that wrote it to a node that
 * reads it, in the variable's colour. A dashed one has no order between the
 * two nodes: either could run first.
 */
import {
  BaseEdge, EdgeLabelRenderer, getBezierPath, Position, type Edge, type EdgeProps,
} from "@xyflow/react";
import { Plus } from "lucide-react";
import { useState } from "react";

import { orderEdgePath } from "@/core/geometry.js";
import { skippedArea } from "@/core/regions.js";
import { cn } from "@/ui/kit";

export interface OrderEdgeData extends Record<string, unknown> {
  regions: any[];
  portIndex: number;
  trail: boolean;
  live: boolean;
  dashed: boolean;
  canInsert: boolean;
  onInsert: (from: string, portIndex: number, at: { x: number; y: number }) => void;
}

export type OrderEdge = Edge<OrderEdgeData, "order">;

export function OrderEdgeView(props: EdgeProps<OrderEdge>) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, data, selected } = props;
  const [hover, setHover] = useState(false);
  const from = { x: sourceX, y: sourceY };
  const to = { x: targetX, y: targetY };
  const box = skippedArea(data?.regions ?? [], source, target, from, to);
  const path = orderEdgePath(from, to, box);
  const mid = { x: (sourceX + targetX) / 2, y: (sourceY + targetY) / 2 };
  // an edge routed around a block has its middle on the lane beside it, the
  // same lane `orderEdgePath` picks
  let label = mid;
  if (box) {
    const right = box.right + 28;
    const left = box.x - 28;
    const lane = Math.abs(right - from.x) + Math.abs(right - to.x)
      <= Math.abs(left - from.x) + Math.abs(left - to.x) ? right : left;
    label = { x: lane, y: (box.y + box.bottom) / 2 };
  }

  return (
    <g onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      className={cn(data?.trail && "sf-edge-trail", data?.live && "sf-edge-live")}>
      <BaseEdge id={id} path={path} interactionWidth={18}
        style={{
          strokeDasharray: data?.dashed && !data?.live ? "5 4" : undefined,
          stroke: selected ? "var(--accent)" : undefined,
        }}
        markerEnd="url(#sf-arrow)" />
      {data?.canInsert && (hover || selected)
        ? (
          <EdgeLabelRenderer>
            <button
              type="button"
              className="nodrag nopan absolute flex size-5 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-card hover:border-accent hover:text-accent"
              style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)`, pointerEvents: "all" }}
              onMouseEnter={() => setHover(true)}
              onClick={(e) => {
                e.stopPropagation();
                data.onInsert(source, data.portIndex, { x: e.clientX, y: e.clientY });
              }}
            >
              <Plus size={12} strokeWidth={2.5} />
            </button>
          </EdgeLabelRenderer>
        )
        : null}
    </g>
  );
}

export interface DataEdgeData extends Record<string, unknown> {
  name: string;
  color: string;
  ordered: boolean;
  strong: boolean;
}

export type DataEdge = Edge<DataEdgeData, "data">;

export function DataEdgeView(props: EdgeProps<DataEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, data } = props;
  const [path] = getBezierPath({
    sourceX, sourceY, sourcePosition: Position.Right,
    targetX, targetY, targetPosition: Position.Left,
    curvature: 0.4,
  });
  return (
    <BaseEdge id={id} path={path} interactionWidth={0}
      style={{
        stroke: data?.color,
        strokeWidth: data?.strong ? 1.75 : 1.25,
        opacity: data?.strong ? 0.95 : 0.55,
        strokeDasharray: data?.ordered ? undefined : "3 3",
      }} />
  );
}

/** The arrowhead every order edge ends with, defined once. */
export function EdgeDefs() {
  return (
    <svg className="absolute size-0">
      <defs>
        <marker id="sf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 1 1.5 L 8 5 L 1 8.5" fill="none" stroke="var(--edge)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>
    </svg>
  );
}

/** The dashed line from a call to the subpipeline's frame. */
export function SubrefEdgeView(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY } = props;
  const [path] = getBezierPath({
    sourceX, sourceY, sourcePosition: Position.Right,
    targetX, targetY, targetPosition: Position.Left,
    curvature: 0.3,
  });
  return <BaseEdge id={id} path={path} interactionWidth={0}
    style={{ stroke: "var(--fg-subtle)", strokeDasharray: "4 4", strokeWidth: 1.25 }} />;
}
