/**
 * Canvas geometry: the size of a node card and the path of an order edge.
 *
 * Used by rendering (canvas.js) and by auto-layout (model.js). The constants
 * must match editor.css.
 *
 * Execution order runs vertically (inlet on top, outlets along the bottom);
 * data runs horizontally (inputs on the left, outputs on the right).
 */
import { kindOf } from "./kinds.js";

export const NODE_MIN_W = 220;
export const ORDER_SLOT_W = 74;   // slot of one order outlet in the bottom bar
export const HEAD_H = 30;
export const SUB_H = 20;
export const DESC_H = 30;         // stage description block (two lines)
export const DATA_ROW_H = 20;
export const ORDER_BAR_H = 32;    // bottom bar with the order outlets

/**
 * Card size and connector positions (local coordinates). The width grows when
 * the order outlets do not fit; the height grows with a description and with
 * each data row.
 */
export function nodeLayout(node, showData = true, env = null) {
  const kind = kindOf(node);
  const ins = showData ? kind.dataIns(node) : [];
  const outs = showData ? kind.dataOuts(node) : [];
  // value rows are part of the node, so they are shown even with data wires off
  const values = kind.valueRows(node);
  const orders = kind.orderPorts(node);
  const hasDescription = Boolean(env?.showDescriptions?.() && kind.description(node, env));

  const width = Math.max(NODE_MIN_W, orders.length * ORDER_SLOT_W);
  const dataTop = HEAD_H + SUB_H + (hasDescription ? DESC_H : 0);
  const height = dataTop + (ins.length + values.length + outs.length) * DATA_ROW_H
    + (orders.length ? ORDER_BAR_H : 8);

  return {
    ins, outs, values, orders, width, height, hasDescription,
    /** order inlet: the middle of the top edge */
    orderIn: { dx: width / 2, dy: 0 },
    /** order outlet k: spread evenly along the bottom edge */
    orderOut: (k) => ({
      dx: orders.length ? (width / orders.length) * (k + 0.5) : width / 2,
      dy: height,
    }),
    /** data input i: on the left edge */
    dataIn: (i) => ({ dx: 0, dy: dataTop + i * DATA_ROW_H + DATA_ROW_H / 2 }),
    /** data output j: on the right edge, below the inputs and value rows */
    dataOut: (j) => ({
      dx: width,
      dy: dataTop + (ins.length + values.length + j) * DATA_ROW_H + DATA_ROW_H / 2,
    }),
  };
}

/** How far outside a region's frame an edge goes around it. */
const LANE = 28;

/** Whether the straight edge a→b crosses `box`. Only the corridor between the
 * ends (widened for the curve) counts, so an edge passing beside a region is
 * not rerouted. */
export function crossesBox(a, b, box) {
  if (!box) return false;
  if (Math.max(a.y, b.y) <= box.y || Math.min(a.y, b.y) >= box.bottom) return false;
  return Math.max(a.x, b.x) + 10 > box.x && Math.min(a.x, b.x) - 10 < box.right;
}

/**
 * The path of an order edge: a vertical bézier, routed around `box` when the
 * straight one would cross it.
 *
 * `box` is the region the edge skips: a loop body for the loop's `next`, the
 * whole block for what follows a `try`. Drawn straight, the edge would run
 * behind the body's cards, so it goes around the nearer side of the frame.
 */
export function orderEdgePath(a, b, box = null) {
  if (!crossesBox(a, b, box)) {
    const dy = Math.max(48, Math.abs(b.y - a.y) / 2);
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`;
  }
  const right = box.right + LANE;
  const left = box.x - LANE;
  // take the shorter detour
  const lane = Math.abs(right - a.x) + Math.abs(right - b.x)
    <= Math.abs(left - a.x) + Math.abs(left - b.x) ? right : left;

  // the straight part spans the frame's height; the curved ends stay outside
  const enter = Math.max(a.y + 12, Math.min(box.y, b.y - 12));
  const exit = Math.min(b.y - 12, Math.max(box.bottom, a.y + 12));
  if (exit <= enter) return orderEdgePath(a, b, null);

  return `M ${a.x} ${a.y}`
    + ` C ${a.x} ${a.y + 14}, ${lane} ${enter - 14}, ${lane} ${enter}`
    + ` L ${lane} ${exit}`
    + ` C ${lane} ${exit + 14}, ${b.x} ${b.y - 14}, ${b.x} ${b.y}`;
}
