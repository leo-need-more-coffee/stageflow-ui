/**
 * Geometry of a node card — the single source of truth about sizes.
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
