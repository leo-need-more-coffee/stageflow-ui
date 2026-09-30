/**
 * Geometry of the canvas: the size of a node card and the path of an order
 * edge — the single source of truth about both.
 *
 * Used both by rendering (canvas.js) and by auto-layout (model.js), which is
 * why it lives apart from the presentation. The constants agree with
 * editor.css: they must not be changed one without the other.
 *
 * Axes: execution order is VERTICAL (the inlet on top, outlets along the
 * bottom edge), data flows are HORIZONTAL (inputs on the left, outputs on the
 * right).
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
 * Card size and the attachment points of the connectors (local coordinates).
 * The width grows when there are more order outlets than fit the minimum; the
 * height grows when a stage has a description and with every extra connector.
 */
export function nodeLayout(node, showData = true, env = null) {
  const kind = kindOf(node);
  const ins = showData ? kind.dataIns(node) : [];
  const outs = showData ? kind.dataOuts(node) : [];
  // value rows are always visible: they are not a data layer but a property of
  // the node itself, and there is no reason to hide them with the wires
  const values = kind.valueRows(node);
  const orders = kind.orderPorts(node);
  const hasDescription = Boolean(env?.showDescriptions?.() && kind.description(node, env));

  const width = Math.max(NODE_MIN_W, orders.length * ORDER_SLOT_W);
  const dataTop = HEAD_H + SUB_H + (hasDescription ? DESC_H : 0);
  const height = dataTop + (ins.length + values.length + outs.length) * DATA_ROW_H
    + (orders.length ? ORDER_BAR_H : 8);

  return {
    ins, outs, values, orders, width, height, hasDescription,
    /** order inlet — the centre of the top edge */
    orderIn: { dx: width / 2, dy: 0 },
    /** order outlet k — along the bottom edge, in equal shares */
    orderOut: (k) => ({
      dx: orders.length ? (width / orders.length) * (k + 0.5) : width / 2,
      dy: height,
    }),
    /** data input i — the left edge */
    dataIn: (i) => ({ dx: 0, dy: dataTop + i * DATA_ROW_H + DATA_ROW_H / 2 }),
    /** data output j — the right edge (below the reads and the value rows) */
    dataOut: (j) => ({
      dx: width,
      dy: dataTop + (ins.length + values.length + j) * DATA_ROW_H + DATA_ROW_H / 2,
    }),
  };
}

/** The lane an edge takes around an area it steps over: how far outside the
 * frame the straight run goes. */
const LANE = 28;

/** Does the straight edge a→b run across `box`?
 *
 * Only the corridor between the two ends is asked about, widened a little for
 * the bulge of the bézier: an edge that leaves to the side of an area passes
 * nowhere near it, and must not be rerouted for nothing. */
export function crossesBox(a, b, box) {
  if (!box) return false;
  if (Math.max(a.y, b.y) <= box.y || Math.min(a.y, b.y) >= box.bottom) return false;
  return Math.max(a.x, b.x) + 10 > box.x && Math.min(a.x, b.x) - 10 < box.right;
}

/**
 * The path of an order edge: a vertical bézier, and around `box` when the
 * straight one would cross it.
 *
 * `box` is the area the edge STEPS OVER — the body of a loop for its `next`,
 * the whole block for what comes after a `try`. Drawn straight, such an edge
 * goes behind the cards of the body: the exit of the loop disappears, and the
 * first node of the body is left with two wires coming in, one of which is not
 * its own. The way around is drawn along the nearer side of the frame, so the
 * edge stays visible, hoverable and cuttable over its whole length.
 */
export function orderEdgePath(a, b, box = null) {
  if (!crossesBox(a, b, box)) {
    const dy = Math.max(48, Math.abs(b.y - a.y) / 2);
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`;
  }
  const right = box.right + LANE;
  const left = box.x - LANE;
  // the shorter detour wins — usually the side the port is already on
  const lane = Math.abs(right - a.x) + Math.abs(right - b.x)
    <= Math.abs(left - a.x) + Math.abs(left - b.x) ? right : left;

  // the straight run covers exactly the height of the frame, so the curved
  // ends stay outside it
  const enter = Math.max(a.y + 12, Math.min(box.y, b.y - 12));
  const exit = Math.min(b.y - 12, Math.max(box.bottom, a.y + 12));
  if (exit <= enter) return orderEdgePath(a, b, null);

  return `M ${a.x} ${a.y}`
    + ` C ${a.x} ${a.y + 14}, ${lane} ${enter - 14}, ${lane} ${enter}`
    + ` L ${lane} ${exit}`
    + ` C ${lane} ${exit + 14}, ${b.x} ${b.y - 14}, ${b.x} ${b.y}`;
}
