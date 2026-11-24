/**
 * The canvas: the graphs being edited, drawn by React Flow.
 *
 * The graphs live in the core model; this component draws them and turns
 * gestures into model edits. Positions are the one thing it holds itself,
 * and only while a card is being dragged: the drop writes them to the model,
 * so a drag is one undo step rather than a hundred.
 *
 * With subpipelines shown beside the main graph (see `scene.ts`), a click on
 * a node in a frame makes that subpipeline the graph being edited, quietly:
 * the inspector, undo, delete and paste all work on it as they would on a
 * subpipeline opened on its own.
 */
import {
  Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow,
  SelectionMode, type FinalConnectionState, type Node, type NodeChangeset, type XYPosition,
} from "@xyflow/react";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { t } from "@/core/i18n.js";
import {
  Button, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
  cn, Kbd, Popover, PopoverAnchor, PopoverContent, PopoverTrigger, Tip,
} from "@/ui/kit";

import { AddNodeMenu, type NodeSpec } from "../AddNodeMenu";
import { useEditor } from "../context";
import { DataEdgeView, EdgeDefs, OrderEdgeView, SubrefEdgeView } from "./edges";
import { NodeCard, RegionFrame, SubgraphFrame } from "./NodeCard";
import { buildEdges, buildNodes, FRAME_HEAD, FRAME_PAD, fid, parseFid, shownGraphs, toGraph, type Shown } from "./scene";

const nodeTypes = { card: NodeCard, region: RegionFrame, frame: SubgraphFrame };
const edgeTypes = { order: OrderEdgeView, data: DataEdgeView, subref: SubrefEdgeView };

/** Where the add menu is open, and what the picked node will be attached to. */
type AddAt =
  | { screen: XYPosition; flow: XYPosition; mode: "free"; key: string | null }
  | { screen: XYPosition; flow: XYPosition; mode: "connect"; key: string | null; from: string; portIndex: number }
  | { screen: XYPosition; flow: XYPosition; mode: "insert"; key: string | null; from: string; portIndex: number };

function CanvasInner() {
  const editor = useEditor();
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const dragged = useRef(new Map<string, XYPosition>());
  const pointer = useRef<XYPosition | null>(null);
  const focusing = useRef<{ id: string; until: number } | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [addAt, setAddAt] = useState<AddAt | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // for a moment after an outside change, cards glide to their new places
  // instead of jumping (never while dragging: a card must follow the hand)
  const [gliding, setGliding] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const glide = () => {
      setGliding(true);
      clearTimeout(timer);
      timer = setTimeout(() => setGliding(false), 700);
    };
    editor.addEventListener("incoming", glide);
    return () => { editor.removeEventListener("incoming", glide); clearTimeout(timer); };
  }, [editor]);

  // "A" anywhere, or "add node" in the command palette
  useEffect(() => {
    const open = () => setAddOpen(true);
    editor.addEventListener("open-add", open);
    return () => editor.removeEventListener("open-add", open);
  }, [editor]);

  const rev = editor.version;
  const shown = useMemo(() => shownGraphs(editor), [editor, rev]);
  const shownOf = useCallback((key: string | null): Shown =>
    shown.find((g) => g.key === key) ?? { key, graph: editor.graphOf(key), frame: null }, [shown, editor]);
  const openAlone = useCallback((key: string) => editor.openGraph(key), [editor]);
  const rebuild = useCallback(() => setNodes(buildNodes(editor, shown, dragged.current, rev, openAlone)), [editor, shown, rev, openAlone]);
  useEffect(rebuild, [rebuild]);
  // the gesture handlers are made once; they reach the current scene here
  const rebuildRef = useRef(rebuild);
  rebuildRef.current = rebuild;

  /**
   * Fit the graph, unless that makes the cards unreadable: a long pipeline
   * fitted whole is a column of specks. Then the top of the graph is shown at
   * a size that can be read, and the rest is a scroll away.
   */
  const fitReadable = useCallback(async () => {
    await flow.fitView({ padding: 0.15, duration: 0, maxZoom: 1.1 });
    const zoom = flow.getZoom();
    if (zoom >= 0.6) return;
    const bounds = flow.getNodesBounds(flow.getNodes().filter((n) => n.type === "card" && !n.parentId));
    const rect = wrapper.current?.getBoundingClientRect();
    if (!rect) return;
    const readable = 0.8;
    void flow.setViewport({
      x: rect.width / 2 - (bounds.x + bounds.width / 2) * readable,
      y: 40 - bounds.y * readable,
      zoom: readable,
    });
  }, [flow]);

  // the canvas tells the editor how to reach it: fit, centre, paste point,
  // all in the coordinates of the graph being edited
  useEffect(() => {
    const own = (at: XYPosition) => toGraph(shownOf(editor.model.graphKey), at);
    editor.canvas = {
      fitView: () => void fitReadable(),
      centerWorld: () => {
        const rect = wrapper.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return own(flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }));
      },
      pasteAnchor: () => (pointer.current ? own(flow.screenToFlowPosition(pointer.current)) : null),
      focusNode: (id) => {
        // remembered for a moment: if the canvas narrows next (the inspector
        // opening for this very node), the node is brought into view again
        focusing.current = { id, until: Date.now() + 800 };
        const node = flow.getInternalNode(fid(editor.model.graphKey, id));
        if (!node) return;
        const at = node.internals.positionAbsolute;
        const rect = wrapper.current?.getBoundingClientRect();
        const zoom = flow.getZoom();
        const w = node.width ?? 220;
        const h = node.height ?? 80;
        // only move when the card is not already comfortably in view
        if (rect) {
          const p = flow.flowToScreenPosition(at);
          const inside = p.x > rect.left + 20 && p.y > rect.top + 20
            && p.x + w * zoom < rect.right - 20 && p.y + h * zoom < rect.bottom - 20;
          if (inside) return;
        }
        // from the canvas's real size: React Flow's own idea of it lags a
        // frame behind when the inspector has just opened
        const width = rect?.width ?? 0;
        const height = rect?.height ?? 0;
        void flow.setViewport({
          x: width / 2 - (at.x + w / 2) * zoom,
          y: height / 2 - (at.y + h / 2) * zoom,
          zoom,
        }, { duration: 250 });
      },
    };
    return () => { editor.canvas = null; };
  }, [editor, flow, fitReadable, shownOf]);

  useEffect(() => {
    const host = wrapper.current;
    if (!host) return;
    let width = host.clientWidth;
    const observer = new ResizeObserver(() => {
      const narrower = host.clientWidth < width;
      width = host.clientWidth;
      const pending = focusing.current;
      // a frame later, once React Flow has measured its new size too
      if (narrower && pending && pending.until > Date.now()) {
        requestAnimationFrame(() => editor.canvas?.focusNode(pending.id));
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [editor]);

  const onInsert = useCallback((from: string, portIndex: number, at: XYPosition) => {
    const { key, id } = parseFid(from);
    setAddAt({ mode: "insert", key, from: id, portIndex, screen: at, flow: flow.screenToFlowPosition(at) });
  }, [flow]);

  const edges = useMemo(() => buildEdges(editor, shown, nodes, { hovered, onInsert }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, shown, nodes, hovered, onInsert, rev]);

  // ------------------------------------------------------------ gestures

  const onNodesChange = useCallback((changes: NodeChangeset<Node>) => {
    let picked: { key: string | null; ids: Set<string> } | null = null;
    let moved = false;
    for (const change of changes.toArray() as any[]) {
      const flowId = String(change.id ?? "");
      if (flowId.startsWith("region:")) continue;
      if (change.type === "position" && change.position) {
        dragged.current.set(flowId, change.position);
        moved = true;
      }
      if (change.type === "select" && !flowId.startsWith("frame:")) {
        const { key, id } = parseFid(flowId);
        if (key !== editor.model.graphKey) {
          // a node of another graph: that graph becomes the one being edited
          if (change.selected) picked = { key, ids: new Set([id]) };
          continue;
        }
        if (picked && picked.key !== key) continue;
        picked ??= { key, ids: new Set(editor.selection.nodes) };
        if (change.selected) picked.ids.add(id);
        else picked.ids.delete(id);
      }
    }
    // the whole scene, not just the moved cards: the frame of a loop or a
    // try around them has to grow and shrink with the hand
    if (moved) rebuildRef.current();
    if (picked) {
      if (picked.key !== editor.model.graphKey) editor.focusGraph(picked.key);
      const ids = picked.ids;
      const same = ids.size === editor.selection.nodes.size && [...ids].every((id) => editor.selection.has(id));
      if (!same) editor.selection.setNodes(ids);
    }
  }, [editor]);

  const onNodeDragStop = useCallback(() => {
    if (!dragged.current.size) return;
    let touched = false;
    for (const [flowId, at] of dragged.current) {
      if (flowId.startsWith("frame:")) {
        // a frame moved: its subpipeline's nodes keep their own coordinates
        const key = flowId.slice("frame:".length);
        const frame = editor.frames.get(key);
        // in place: the scene holds this very object
        if (frame) Object.assign(frame, { x: Math.round(at.x), y: Math.round(at.y) });
        continue;
      }
      const { key, id } = parseFid(flowId);
      const node = editor.graphOf(key)?.nodes.find((n: any) => n.id === id);
      if (!node) continue;
      const frame = shownOf(key).frame;
      const ui = frame
        ? { x: at.x - FRAME_PAD + frame.ox, y: at.y - FRAME_HEAD - FRAME_PAD + frame.oy }
        : at;
      node.metadata = { ...(node.metadata ?? {}), ui: { x: Math.round(ui.x), y: Math.round(ui.y) } };
      touched = true;
    }
    dragged.current.clear();
    if (touched) editor.model.touch();
    else rebuild();
  }, [editor, shownOf, rebuild]);

  const onConnect = useCallback((c: { source: string; sourceHandle?: string | null; target: string }) => {
    const from = parseFid(c.source);
    const to = parseFid(c.target);
    const index = Number(c.sourceHandle?.slice(1));
    if (from.key !== to.key || !Number.isInteger(index)) return;
    editor.focusGraph(from.key);
    editor.model.connect(from.id, index, to.id);
  }, [editor]);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || !state.fromNode || !state.fromHandle?.id?.startsWith("o")) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    const screen = { x: point.clientX, y: point.clientY };
    const { key, id } = parseFid(state.fromNode.id);
    setAddAt({
      mode: "connect", key, from: id, portIndex: Number(state.fromHandle.id.slice(1)),
      screen, flow: flow.screenToFlowPosition(screen),
    });
  }, [flow]);

  const pick = useCallback((spec: NodeSpec) => {
    if (!addAt) return;
    editor.focusGraph(addAt.key);
    const at = toGraph(shownOf(addAt.key), addAt.flow);
    const pos = { x: at.x - 110, y: at.y };
    let created: any = null;
    if (addAt.mode === "connect") created = editor.model.createConnected(addAt.from, addAt.portIndex, spec, pos);
    else if (addAt.mode === "insert") {
      created = editor.model.insertOnEdge(addAt.from, addAt.portIndex, spec);
      if (!created) editor.toast(t("app.add.cannotInsert"), "bad");
    }
    else created = editor.model.createAt(spec, pos);
    setAddAt(null);
    if (created) editor.selection.set({ type: "node", id: created.id });
  }, [addAt, editor, shownOf]);

  const onPaneDoubleClick = (event: ReactMouseEvent) => {
    const target = event.target as HTMLElement;
    const frame = target.closest(".react-flow__node-frame");
    if (!frame && !target.classList.contains("react-flow__pane")) return;
    const screen = { x: event.clientX, y: event.clientY };
    // inside a frame the new node goes into that subpipeline
    const key = frame ? (frame.getAttribute("data-id") ?? "").slice("frame:".length) : (editor.framed ? null : editor.model.graphKey);
    setAddAt({ mode: "free", key, screen, flow: flow.screenToFlowPosition(screen) });
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
    <div ref={wrapper} className={cn("relative size-full", gliding && "sf-gliding")} onDoubleClick={onPaneDoubleClick}
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
              isValidConnection={(c) => Boolean(c.sourceHandle?.startsWith("o")) && c.targetHandle === "in"
                && c.source !== c.target && parseFid(c.source).key === parseFid(c.target).key}
              onNodeMouseEnter={(_, node) => { if (node.type === "card") setHovered(node.id); }}
              onNodeMouseLeave={() => setHovered(null)}
              onNodeContextMenu={(_, node) => {
                if (node.type !== "card") return;
                const { key, id } = parseFid(node.id);
                editor.focusGraph(key);
                if (!editor.selection.has(id)) editor.selection.set({ type: "node", id });
              }}
              onEdgeClick={(_, edge) => {
                if (edge.type !== "order") return;
                const { key, id } = parseFid(edge.source);
                editor.focusGraph(key);
                editor.selection.set({ type: "edge", from: id, portIndex: Number(edge.sourceHandle?.slice(1)) });
              }}
              onPaneClick={() => { if (sel) editor.selection.clear(); }}
              onMoveEnd={(_, viewport) => { editor.view = viewport; editor.persist(); }}
              defaultViewport={editor.savedView ?? undefined}
              onInit={() => { if (!editor.savedView) void fitReadable(); }}
              minZoom={0.15}
              maxZoom={2}
              zoomOnDoubleClick={false}
              deleteKeyCode={null}
              selectionKeyCode="Shift"
              attributionPosition="top-right"
              multiSelectionKeyCode={["Shift", "Meta", "Control"]}
              panOnScroll
              // dragging the empty canvas selects, as in a design tool; the
              // wheel, a touchpad, the middle button or Space+drag pan
              selectionOnDrag
              panOnDrag={[1]}
              selectionMode={SelectionMode.Partial}
              connectionRadius={28}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--canvas-dot)" />
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap position="bottom-right" pannable zoomable nodeColor={(n) => (n.type === "card" ? "var(--border-strong)" : "transparent")}
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
              <Button variant="default" size="md" className="bg-surface pl-2.5 shadow-card">
                <Plus /> {t("app.add.button")}
              </Button>
            </PopoverTrigger>
          </Tip>
          <PopoverContent className="p-0" side="bottom">
            <AddNodeMenu onPick={(spec) => { setAddOpen(false); editor.addNode(spec.type, spec.extra); }} />
          </PopoverContent>
        </Popover>
      </div>

      {!editor.framed && editor.model.graph.nodes.length === 0
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
