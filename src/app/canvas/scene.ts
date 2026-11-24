/**
 * What the canvas shows: one graph, or the main graph with each subpipeline
 * in a frame beside it.
 *
 * The model keeps every graph in coordinates of its own. On the canvas a
 * subpipeline's nodes are children of its frame (so dragging the frame
 * carries them), placed relative to it; `origin` is the point of the
 * subpipeline's own coordinates that sits at the frame's top-left corner.
 *
 * React Flow needs ids unique across the canvas, and two graphs may well
 * both have a node called `start`, so a subpipeline's ids are prefixed with
 * its key (`review::start`). The root's ids stay as they are.
 */
import type { Edge, Node, XYPosition } from "@xyflow/react";

import { varColor } from "@/core/colors.js";
import { dataLinks } from "@/core/dataflow.js";
import { nodeLayout } from "@/core/geometry.js";
import { t } from "@/core/i18n.js";
import { computeRegions, regionBounds } from "@/core/regions.js";

import type { Editor } from "../editor";
import type { CardData, CardNode, RunMark } from "./NodeCard";

export const FRAME_PAD = 28;
export const FRAME_HEAD = 40;
const FRAME_GAP_X = 220;
const FRAME_GAP_Y = 90;
const EMPTY = { width: 280, height: 120 };

const SEP = "::";

/** A canvas id from a graph and a node id. */
export function fid(key: string | null, id: string) {
  return key === null ? id : `${key}${SEP}${id}`;
}

/** The graph and node id behind a canvas id. */
export function parseFid(flowId: string): { key: string | null; id: string } {
  const at = flowId.indexOf(SEP);
  return at < 0 ? { key: null, id: flowId } : { key: flowId.slice(0, at), id: flowId.slice(at + SEP.length) };
}

export interface Shown {
  key: string | null;
  graph: any;
  /** null for the graph drawn without a frame */
  frame: { x: number; y: number; ox: number; oy: number } | null;
}

function boundsOf(graph: any, editor: Editor) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of graph?.nodes ?? []) {
    const { x, y } = node.metadata?.ui ?? { x: 0, y: 0 };
    const { width, height } = nodeLayout(node, editor.showData);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/** The graphs on the canvas, the frames placed the first time they are seen. */
export function shownGraphs(editor: Editor): Shown[] {
  if (!editor.framed) {
    return [{ key: editor.model.graphKey, graph: editor.model.graph, frame: null }];
  }
  const root = editor.model.pipeline;
  const shown: Shown[] = [{ key: null, graph: root, frame: null }];
  const main = boundsOf(root, editor) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  // a new frame goes under the lowest one already placed, right of the main graph
  let nextY = main.minY;
  for (const placed of editor.frames.values()) {
    nextY = Math.max(nextY, placed.y + 200 + FRAME_GAP_Y);
  }
  for (const key of Object.keys(root.subpipelines ?? {}).sort()) {
    const graph = root.subpipelines[key];
    let frame = editor.frames.get(key);
    if (!frame) {
      const own = boundsOf(graph, editor);
      frame = { x: main.maxX + FRAME_GAP_X, y: nextY, ox: own?.minX ?? 0, oy: own?.minY ?? 0 };
      editor.frames.set(key, frame);
      const height = own ? own.maxY - own.minY : EMPTY.height;
      nextY += height + FRAME_HEAD + FRAME_PAD * 2 + FRAME_GAP_Y;
    }
    shown.push({ key, graph, frame });
  }
  return shown;
}

/** A point in canvas coordinates as a point in a graph's own coordinates. */
export function toGraph(shown: Shown, at: XYPosition): XYPosition {
  if (!shown.frame) return at;
  return {
    x: at.x - shown.frame.x - FRAME_PAD + shown.frame.ox,
    y: at.y - shown.frame.y - FRAME_HEAD - FRAME_PAD + shown.frame.oy,
  };
}

function runMark(editor: Editor, key: string | null, id: string): RunMark {
  const runner = editor.runner;
  // a run is followed on the main graph; a subpipeline's own steps are not
  // in the run's node trail
  if (runner.status === "idle" || key !== null) return null;
  if (runner.node === id) {
    if (runner.status === "failed") return "failed";
    if (runner.status === "awaiting") return "awaiting";
    if (runner.status === "paused") return "paused";
    if (runner.status === "running") return "current";
  }
  return runner.visited.includes(id) ? "visited" : null;
}

/** The frames and the cards of every graph shown. */
export function buildNodes(editor: Editor, shown: Shown[], dragged: Map<string, XYPosition>, rev: number,
  onOpen: (key: string) => void): Node[] {
  const env = { stages: editor.stages, backend: editor.backend, showDescriptions: () => editor.showDescriptions };
  const marks = editor.marks && editor.marks.until > Date.now() ? editor.marks.ids : null;
  const running = editor.runner.status !== "idle";
  const out: Node[] = [];
  for (const { key, graph, frame } of shown) {
    const issuesByNode = new Map<string, string[]>();
    for (const issue of editor.issues) {
      if (issue.graph !== key || !issue.node) continue;
      issuesByNode.set(issue.node, [...(issuesByNode.get(issue.node) ?? []), issue.message]);
    }
    const editing = key === editor.model.graphKey;
    const cards: CardNode[] = (graph?.nodes ?? []).map((node: any) => {
      const id = fid(key, node.id);
      const layout = nodeLayout(node, editor.showData, env);
      const run = runMark(editor, key, node.id);
      const ui = node.metadata?.ui ?? { x: 0, y: 0 };
      const position = dragged.get(id) ?? (frame
        ? { x: ui.x - frame.ox + FRAME_PAD, y: ui.y - frame.oy + FRAME_HEAD + FRAME_PAD }
        : { x: ui.x, y: ui.y });
      return {
        id,
        type: "card",
        position,
        width: layout.width,
        height: layout.height,
        selected: editing && editor.selection.has(node.id),
        ...(frame ? { parentId: `frame:${key}` } : {}),
        data: {
          node, layout, env, rev, run,
          isEntry: graph.entry === node.id,
          issues: issuesByNode.get(node.id) ?? [],
          marked: editing && Boolean(marks?.has(node.id)),
          dim: running && run === null,
          highlightVar: editor.highlightedVar,
          labels: { entry: t("app.card.entry") },
        } satisfies CardData,
      };
    });
    if (frame) {
      // the frame grows around wherever its cards are, mid-drag included
      let maxX = EMPTY.width, maxY = EMPTY.height;
      for (const card of cards) {
        maxX = Math.max(maxX, card.position.x + (card.width ?? 220) + FRAME_PAD);
        maxY = Math.max(maxY, card.position.y + (card.height ?? 80) + FRAME_PAD);
      }
      const callers = (editor.model.pipeline.nodes ?? []).filter((n: any) => n.type === "subpipeline" && n.subpipeline_id === key).length;
      out.push({
        id: `frame:${key}`,
        type: "frame",
        position: dragged.get(`frame:${key}`) ?? { x: frame.x, y: frame.y },
        width: maxX,
        height: maxY,
        zIndex: -2,
        selectable: false,
        focusable: false,
        dragHandle: ".sf-frame-handle",
        data: {
          key: key!, count: cards.length, callers, editing, onOpen,
          labels: { sub: t("app.frame.sub") },
          summary: callers ? t("app.frame.summary", { nodes: cards.length, callers }) : t("app.frame.unused", { nodes: cards.length }),
          openTitle: t("app.frame.open"),
          emptyText: t("app.frame.empty"),
        },
      });
    }
    out.push(...regionNodes(editor, key, graph, cards, frame), ...cards);
  }
  return out;
}

/** The blocks (try bodies, loops, branches) of one graph, as frames behind its cards. */
function regionNodes(editor: Editor, key: string | null, graph: any, cards: CardNode[], frame: Shown["frame"]): Node[] {
  const byId = new Map(cards.map((c) => [parseFid(c.id).id, c]));
  const placed = {
    nodes: (graph?.nodes ?? []).map((n: any) => {
      const card = byId.get(n.id);
      return card ? { ...n, metadata: { ...n.metadata, ui: card.position } } : n;
    }),
  };
  const list: Node[] = [];
  for (const region of computeRegions(graph, { stages: editor.stages })) {
    const box = regionBounds(region, placed, (n: any) => byId.get(n.id)?.data.layout ?? { width: 220, height: 80 }, 22, 22);
    if (!box) continue;
    list.push({
      id: `region:${fid(key, region.key)}`,
      type: "region",
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      zIndex: -1,
      selectable: false,
      draggable: false,
      focusable: false,
      ...(frame ? { parentId: `frame:${key}` } : {}),
      data: { title: region.title, color: region.color, owner: region.ownerId, members: [...region.members] },
    });
  }
  return list;
}

/**
 * The regions of a graph in canvas coordinates, for routing its order edges
 * around the blocks they skip.
 */
export function absoluteRegions(nodes: Node[], key: string | null) {
  const frame = key === null ? null : nodes.find((n) => n.id === `frame:${key}`);
  const dx = frame?.position.x ?? 0;
  const dy = frame?.position.y ?? 0;
  const prefix = `region:${key === null ? "" : `${key}${SEP}`}`;
  return nodes
    .filter((n) => n.type === "region" && n.id.startsWith(prefix) && (key !== null || !n.id.slice(prefix.length).includes(SEP)))
    .map((n: any) => ({
      ownerId: fid(key, n.data.owner),
      members: new Set((n.data.members as string[]).map((m) => fid(key, m))),
      box: { x: n.position.x + dx, y: n.position.y + dy, width: n.width, height: n.height },
    }));
}

export interface EdgeOptions {
  hovered: string | null;
  onInsert: (from: string, portIndex: number, at: XYPosition) => void;
}

/** The order edges, the data edges and the dashed line from a call to its frame. */
export function buildEdges(editor: Editor, shown: Shown[], nodes: Node[], { hovered, onInsert }: EdgeOptions): Edge[] {
  const out: Edge[] = [];
  const visited: string[] = editor.runner.visited;
  const walked = new Set<string>();
  for (let i = 1; i < visited.length; i++) walked.add(`${visited[i - 1]}>${visited[i]}`);
  const live = editor.runner.active;
  const selectedEdge = editor.selection.current?.type === "edge" ? editor.selection.current : null;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const { key, graph } of shown) {
    const regions = absoluteRegions(nodes, key);
    const ids = new Set((graph?.nodes ?? []).map((n: any) => n.id));
    const editing = key === editor.model.graphKey;
    for (const node of graph?.nodes ?? []) {
      const card = byId.get(fid(key, node.id)) as CardNode | undefined;
      if (!card) continue;
      card.data.layout.orders.forEach((port: any, k: number) => {
        if (port.add) return;
        const target = port.get?.();
        if (!target || !ids.has(target)) return;
        const trail = key === null && walked.has(`${node.id}>${target}`);
        out.push({
          id: `o:${fid(key, node.id)}:${k}`,
          type: "order",
          source: fid(key, node.id),
          sourceHandle: `o${k}`,
          target: fid(key, target),
          targetHandle: "in",
          selected: Boolean(editing && selectedEdge && selectedEdge.from === node.id && selectedEdge.portIndex === k),
          data: {
            regions, portIndex: k, trail,
            live: live && trail && editor.runner.node === target,
            dashed: Boolean(port.dashed),
            canInsert: true,
            onInsert,
          },
        });
      });
      // a call to a subpipeline shown in a frame points at the frame
      if (node.type === "subpipeline" && node.subpipeline_id && byId.has(`frame:${node.subpipeline_id}`)) {
        out.push({
          id: `s:${fid(key, node.id)}`,
          type: "subref",
          source: fid(key, node.id),
          sourceHandle: "sub",
          target: `frame:${node.subpipeline_id}`,
          targetHandle: "frame",
          selectable: false,
          focusable: false,
        });
      }
    }

    if (editor.dataMode !== "off") {
      const focus = new Set<string>();
      if (hovered) focus.add(hovered);
      if (editing) for (const id of editor.selection.nodes) focus.add(fid(key, id));
      dataLinks(graph).forEach((link: any, i: number) => {
        const writer = fid(key, link.writerId);
        const reader = fid(key, link.readerId);
        const strong = focus.has(writer) || focus.has(reader) || editor.highlightedVar === link.name;
        if (editor.dataMode === "focus" && !strong) return;
        out.push({
          id: `d:${fid(key, String(i))}:${writer}:${reader}:${link.name}`,
          type: "data",
          source: writer,
          sourceHandle: `dout${link.outIndex}`,
          target: reader,
          targetHandle: `din${link.inIndex}`,
          selectable: false,
          focusable: false,
          zIndex: 1,
          data: { name: link.name, color: varColor(link.name), ordered: link.ordered, strong },
        });
      });
    }
  }
  return out;
}
