/**
 * The canvas: the graph being edited, drawn by React Flow.
 *
 * The graph lives in the core model; this component draws it and turns
 * gestures into model edits. Positions are the one thing it holds itself,
 * and only while a card is being dragged: the drop writes them to the model,
 * so a drag is one undo step rather than a hundred.
 */
import {
  Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type FinalConnectionState, type Node, type NodeChangeset, type XYPosition,
} from "@xyflow/react";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { varColor } from "@/core/colors.js";
import { dataLinks } from "@/core/dataflow.js";
import { nodeLayout } from "@/core/geometry.js";
import { t } from "@/core/i18n.js";
import { computeRegions, regionBounds } from "@/core/regions.js";
import {
  Button, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
  Kbd, Popover, PopoverAnchor, PopoverContent, PopoverTrigger, Tip,
} from "@/ui/kit";

import { AddNodeMenu, type NodeSpec } from "../AddNodeMenu";
import { useEditor } from "../context";
import type { Editor } from "../editor";
import { DataEdgeView, EdgeDefs, OrderEdgeView } from "./edges";
import { NodeCard, RegionFrame, type CardData, type CardNode, type RunMark } from "./NodeCard";

const nodeTypes = { card: NodeCard, region: RegionFrame };
const edgeTypes = { order: OrderEdgeView, data: DataEdgeView };

/** Where the add menu is open, and what the picked node will be attached to. */
type AddAt =
  | { screen: XYPosition; flow: XYPosition; mode: "free" }
  | { screen: XYPosition; flow: XYPosition; mode: "connect"; from: string; portIndex: number }
  | { screen: XYPosition; flow: XYPosition; mode: "insert"; from: string; portIndex: number };

function runMark(editor: Editor, id: string): RunMark {
  const runner = editor.runner;
  if (runner.status === "idle") return null;
  if (runner.node === id) {
    if (runner.status === "failed") return "failed";
    if (runner.status === "awaiting") return "awaiting";
    if (runner.status === "paused") return "paused";
    if (runner.status === "running") return "current";
  }
  return runner.visited.includes(id) ? "visited" : null;
}

function buildCards(editor: Editor, dragged: Map<string, XYPosition>, rev: number): CardNode[] {
  const graph = editor.model.graph;
  const env = { stages: editor.stages, backend: editor.backend, showDescriptions: () => editor.showDescriptions };
  const issuesByNode = new Map<string, string[]>();
  for (const issue of editor.issues) {
    if (issue.graph !== editor.model.graphKey || !issue.node) continue;
    issuesByNode.set(issue.node, [...(issuesByNode.get(issue.node) ?? []), issue.message]);
  }
  const marks = editor.marks && editor.marks.until > Date.now() ? editor.marks.ids : null;
  const running = editor.runner.status !== "idle";
  return graph.nodes.map((node: any) => {
    const layout = nodeLayout(node, editor.showData, env);
    const run = runMark(editor, node.id);
    const ui = node.metadata?.ui ?? { x: 0, y: 0 };
    return {
      id: node.id,
      type: "card",
      position: dragged.get(node.id) ?? { x: ui.x, y: ui.y },
      width: layout.width,
      height: layout.height,
      selected: editor.selection.has(node.id),
      data: {
        node, layout, env, rev, run,
        isEntry: graph.entry === node.id,
        issues: issuesByNode.get(node.id) ?? [],
        marked: Boolean(marks?.has(node.id)),
        dim: running && run === null,
        highlightVar: editor.highlightedVar,
        labels: { entry: t("app.card.entry") },
      } satisfies CardData,
    };
  });
}

function CanvasInner() {
  const editor = useEditor();
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const dragged = useRef(new Map<string, XYPosition>());
  const pointer = useRef<XYPosition | null>(null);
  const [cards, setCards] = useState<CardNode[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [addAt, setAddAt] = useState<AddAt | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // "A" anywhere, or "add node" in the command palette
  useEffect(() => {
    const open = () => setAddOpen(true);
    editor.addEventListener("open-add", open);
    return () => editor.removeEventListener("open-add", open);
  }, [editor]);

  const rev = editor.version;
  useEffect(() => {
    setCards(buildCards(editor, dragged.current, rev));
  }, [editor, rev]);

  // the canvas tells the editor how to reach it: fit, centre, paste point
  useEffect(() => {
    editor.canvas = {
      fitView: () => void flow.fitView({ padding: 0.15, duration: 250, maxZoom: 1.1 }),
      centerWorld: () => {
        const rect = wrapper.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      },
      pasteAnchor: () => (pointer.current ? flow.screenToFlowPosition(pointer.current) : null),
      focusNode: (id) => {
        const node = flow.getNode(id);
        if (!node) return;
        const rect = wrapper.current?.getBoundingClientRect();
        const zoom = flow.getZoom();
        const w = node.width ?? 220;
        const h = node.height ?? 80;
        // only move when the card is not already comfortably in view
        if (rect) {
          const p = flow.flowToScreenPosition(node.position);
          const inside = p.x > rect.left + 20 && p.y > rect.top + 20
            && p.x + w * zoom < rect.right - 20 && p.y + h * zoom < rect.bottom - 20;
          if (inside) return;
        }
        void flow.setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom, duration: 250 });
      },
    };
    return () => { editor.canvas = null; };
  }, [editor, flow]);

  // regions are framed around wherever their cards are now, mid-drag included
  const graph = editor.model.graph;
  const { regionNodes, regions } = useMemo(() => {
    const byId = new Map(cards.map((c) => [c.id, c]));
    const placed = {
      nodes: graph.nodes.map((n: any) => {
        const card = byId.get(n.id);
        return card ? { ...n, metadata: { ...n.metadata, ui: card.position } } : n;
      }),
    };
    const env = { stages: editor.stages };
    const found = computeRegions(graph, env);
    const list: Node[] = [];
    for (const region of found) {
      const box = regionBounds(region, placed, (n: any) => byId.get(n.id)?.data.layout ?? { width: 220, height: 80 }, 22, 22);
      region.box = box;
      if (!box) continue;
      list.push({
        id: `region:${region.key}`,
        type: "region",
        position: { x: box.x, y: box.y },
        width: box.width,
        height: box.height,
        zIndex: -1,
        selectable: false,
        draggable: false,
        focusable: false,
        data: { title: region.title, color: region.color },
      });
    }
    return { regionNodes: list, regions: found };
  }, [cards, graph, editor.stages]);

  const nodes = useMemo(() => [...regionNodes, ...cards] as Node[], [regionNodes, cards]);

  const onInsert = useCallback((from: string, portIndex: number, at: XYPosition) => {
    setAddAt({ mode: "insert", from, portIndex, screen: at, flow: flow.screenToFlowPosition(at) });
  }, [flow]);

  const edges = useMemo(() => {
    const out: Edge[] = [];
    const ids = new Set(graph.nodes.map((n: any) => n.id));
    // the run's trail: consecutive nodes of the run, as edges
    const visited: string[] = editor.runner.visited;
    const walked = new Set<string>();
    for (let i = 1; i < visited.length; i++) walked.add(`${visited[i - 1]}>${visited[i]}`);
    const live = editor.runner.active;
    const selectedEdge = editor.selection.current?.type === "edge" ? editor.selection.current : null;

    for (const card of cards) {
      const node = card.data.node;
      card.data.layout.orders.forEach((port: any, k: number) => {
        if (port.add) return;
        const target = port.get?.();
        if (!target || !ids.has(target)) return;
        const trail = walked.has(`${node.id}>${target}`);
        out.push({
          id: `o:${node.id}:${k}`,
          type: "order",
          source: node.id,
          sourceHandle: `o${k}`,
          target,
          targetHandle: "in",
          selected: Boolean(selectedEdge && selectedEdge.from === node.id && selectedEdge.portIndex === k),
          data: {
            regions, portIndex: k, trail,
            live: live && trail && editor.runner.node === target,
            dashed: Boolean(port.dashed),
            canInsert: true,
            onInsert,
          },
        });
      });
    }

    if (editor.dataMode !== "off") {
      const focus = new Set<string>();
      if (hovered) focus.add(hovered);
      for (const id of editor.selection.nodes) focus.add(id);
      dataLinks(graph).forEach((link: any, i: number) => {
        const strong = focus.has(link.writerId) || focus.has(link.readerId)
          || editor.highlightedVar === link.name;
        if (editor.dataMode === "focus" && !strong) return;
        out.push({
          id: `d:${i}:${link.writerId}:${link.readerId}:${link.name}`,
          type: "data",
          source: link.writerId,
          sourceHandle: `dout${link.outIndex}`,
          target: link.readerId,
          targetHandle: `din${link.inIndex}`,
          selectable: false,
          focusable: false,
          zIndex: 1,
          data: { name: link.name, color: varColor(link.name), ordered: link.ordered, strong },
        });
      });
    }
    return out;
  }, [cards, graph, regions, editor, hovered, onInsert, rev]);

  // ------------------------------------------------------------ gestures

  const onNodesChange = useCallback((changes: NodeChangeset<Node>) => {
    let selection: Set<string> | null = null;
    const relevant = changes.toArray().filter((c: any) => !String(c.id ?? "").startsWith("region:"));
    for (const change of relevant) {
      if (change.type === "position" && change.position) dragged.current.set(change.id, change.position);
      if (change.type === "select") {
        selection ??= new Set(editor.selection.nodes);
        if (change.selected) selection.add(change.id);
        else selection.delete(change.id);
      }
    }
    const moves = relevant.filter((c) => c.type === "position");
    if (moves.length) {
      setCards((current) => current.map((card) => {
        const at = dragged.current.get(card.id);
        return at ? { ...card, position: at } : card;
      }));
    }
    if (selection) {
      const same = selection.size === editor.selection.nodes.size
        && [...selection].every((id) => editor.selection.has(id));
      if (!same) editor.selection.setNodes(selection);
    }
  }, [editor]);

  const onNodeDragStop = useCallback(() => {
    if (!dragged.current.size) return;
    for (const [id, at] of dragged.current) {
      const node = editor.model.node(id);
      if (!node) continue;
      node.metadata = { ...(node.metadata ?? {}), ui: { x: Math.round(at.x), y: Math.round(at.y) } };
    }
    dragged.current.clear();
    editor.model.touch();
  }, [editor]);

  const onConnect = useCallback((c: { source: string; sourceHandle?: string | null; target: string }) => {
    const index = Number(c.sourceHandle?.slice(1));
    if (Number.isInteger(index)) editor.model.connect(c.source, index, c.target);
  }, [editor]);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || !state.fromNode || !state.fromHandle?.id?.startsWith("o")) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    const screen = { x: point.clientX, y: point.clientY };
    setAddAt({
      mode: "connect", from: state.fromNode.id, portIndex: Number(state.fromHandle.id.slice(1)),
      screen, flow: flow.screenToFlowPosition(screen),
    });
  }, [flow]);

  const pick = useCallback((spec: NodeSpec) => {
    if (!addAt) return;
    const pos = { x: addAt.flow.x - 110, y: addAt.flow.y };
    let created: any = null;
    if (addAt.mode === "connect") created = editor.model.createConnected(addAt.from, addAt.portIndex, spec, pos);
    else if (addAt.mode === "insert") {
      created = editor.model.insertOnEdge(addAt.from, addAt.portIndex, spec);
      if (!created) editor.toast(t("app.add.cannotInsert"), "bad");
    }
    else created = editor.model.createAt(spec, pos);
    setAddAt(null);
    if (created) editor.selection.set({ type: "node", id: created.id });
  }, [addAt, editor]);

  const onPaneDoubleClick = (event: ReactMouseEvent) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("react-flow__pane")) return;
    const screen = { x: event.clientX, y: event.clientY };
    setAddAt({ mode: "free", screen, flow: flow.screenToFlowPosition(screen) });
  };

  const anchorStyle = addAt && wrapper.current
    ? (() => {
      const rect = wrapper.current.getBoundingClientRect();
      return { left: addAt.screen.x - rect.left, top: addAt.screen.y - rect.top };
    })()
    : null;

  const sel = editor.selection.current;
  const contextNodeIds = [...editor.selection.nodes];

  return (
    <div ref={wrapper} className="relative size-full" onDoubleClick={onPaneDoubleClick}
      onPointerMove={(e) => { pointer.current = { x: e.clientX, y: e.clientY }; }}>
      <EdgeDefs />
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={!contextNodeIds.length}>
          <div className="size-full">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onNodeDragStop={onNodeDragStop}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              isValidConnection={(c) => Boolean(c.sourceHandle?.startsWith("o")) && c.targetHandle === "in" && c.source !== c.target}
              onNodeMouseEnter={(_, node) => { if (node.type === "card") setHovered(node.id); }}
              onNodeMouseLeave={() => setHovered(null)}
              onNodeContextMenu={(_, node) => {
                if (node.type === "card" && !editor.selection.has(node.id)) editor.selection.set({ type: "node", id: node.id });
              }}
              onEdgeClick={(_, edge) => {
                if (edge.type !== "order") return;
                editor.selection.set({ type: "edge", from: edge.source, portIndex: Number(edge.sourceHandle?.slice(1)) });
              }}
              onPaneClick={() => { if (sel) editor.selection.clear(); }}
              onMoveEnd={(_, viewport) => { editor.view = viewport; editor.persist(); }}
              defaultViewport={editor.savedView ?? undefined}
              fitView={!editor.savedView}
              fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
              minZoom={0.15}
              maxZoom={2}
              zoomOnDoubleClick={false}
              deleteKeyCode={null}
              selectionKeyCode="Shift"
              multiSelectionKeyCode={["Shift", "Meta", "Control"]}
              panOnScroll
              selectionOnDrag={false}
              connectionRadius={28}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--canvas-dot)" />
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap position="bottom-right" pannable zoomable nodeColor={(n) => (n.type === "region" ? "transparent" : "var(--border-strong)")}
                nodeStrokeWidth={0} maskStrokeWidth={0} style={{ width: 160, height: 100 }} />
            </ReactFlow>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem shortcut="⌘D" onSelect={() => editor.duplicateSelection()}>{t("app.menu.duplicate")}</ContextMenuItem>
          <ContextMenuItem shortcut="⌘C" onSelect={() => editor.copySelection()}>{t("app.menu.copy")}</ContextMenuItem>
          <ContextMenuItem shortcut="⌘X" onSelect={() => editor.cutSelection()}>{t("app.menu.cut")}</ContextMenuItem>
          {contextNodeIds.length === 1 && editor.model.graph.entry !== contextNodeIds[0]
            ? <ContextMenuItem onSelect={() => editor.model.setEntry(contextNodeIds[0])}>{t("app.menu.makeEntry")}</ContextMenuItem>
            : null}
          <ContextMenuSeparator />
          <ContextMenuItem danger shortcut="⌫" onSelect={() => editor.deleteSelection()}>{t("app.menu.delete")}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* the add button: next to the selected node if one is, else in the middle */}
      <div className="absolute left-3 top-3 z-10">
        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <Tip content={t("app.add.tip")} shortcut="A" side="right">
            <PopoverTrigger asChild>
              <Button variant="default" size="sm" className="bg-surface shadow-card">
                <Plus /> {t("app.add.button")}
              </Button>
            </PopoverTrigger>
          </Tip>
          <PopoverContent className="p-0" side="bottom">
            <AddNodeMenu onPick={(spec) => { setAddOpen(false); editor.addNode(spec.type, spec.extra); }} />
          </PopoverContent>
        </Popover>
      </div>

      {graph.nodes.length === 0
        ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div className="text-[15px] font-medium text-fg">{t("app.empty.title")}</div>
              <div className="mt-1 text-[13px] text-muted">{t("app.empty.lead")}</div>
              <div className="mt-3 flex items-center justify-center gap-1 text-[12px] text-subtle">
                <Kbd>A</Kbd> <span>{t("app.empty.or")}</span> <span>{t("app.empty.dbl")}</span>
              </div>
            </div>
          </div>
        )
        : null}

      <Popover open={Boolean(addAt)} onOpenChange={(open) => { if (!open) setAddAt(null); }}>
        <PopoverAnchor asChild>
          <div className="pointer-events-none absolute size-0" style={anchorStyle ?? { left: 0, top: 0 }} />
        </PopoverAnchor>
        <PopoverContent className="p-0" side="bottom" align="start">
          {addAt ? <AddNodeMenu onPick={pick} onlyContinuing={addAt.mode === "insert"} /> : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
