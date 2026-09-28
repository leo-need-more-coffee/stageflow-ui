# Building a graph

## Two sorts of connectors — on two axes

The memory model of StageFlow is a shared scope: a variable is not "a wire from
A to B", it lives in the frame and is read by any node further down the path.
So the editor shows order and data separately — and puts them on different
axes, so that the layers do not get confused by the eye:

```
              ◇  order inlet (top edge)
        ┌─────────────────┐
   ◯ ──▶│ id              │──▶ ◯     data: horizontal
        │ StageName       │
        │ current ← n     │
        │     value → out │
        ├────────┬────────┤
        │  next  │  else  │
        └───◇────┴───◇────┘
             ▼ order: vertical
```

**Order connectors** — diamonds, **vertical**: the inlet at the centre of the
top edge, the outlets as a bar along the bottom one (`next`, `then`/`else`,
`cases[].next`, `branches[].entry`, `try.body`, `except[].next`, `map.body`).
These are the
real edges from the JSON, drawn as vertical béziers with an arrowhead — a
pipeline reads top to bottom, and parallel branches spread left to right. They
are pulled by the mouse from a port (see below); the `+ case` / `+ branch` /
`+ except` ports create a list item together with its link. A card widens
automatically when there are more outlets than fit the minimum width.

**Data connectors** — circles, **horizontal**: the inputs on the left edge
(`current ← n`), the outputs on the right (`value → total`). Literal arguments
have no connector but are shown on the card as separate rows (see
[the interface](interface.md)). They show which variables a node reads and
writes, right on the card. There are no data edges in the JSON: they are
derived from the graph — from the nearest writer of a variable to its reader
(see below) — and painted in the stable color of that variable, so the path of
every variable through the graph is visible at a glance.

The non-obvious reads are counted too: `vars.x` references (and `vars['name']`
— that is how names CEL cannot parse with a dot are addressed) inside CEL
expressions (`condition`, `when`, arguments with `.$`, the variables of an
`entry` node), the `inputs`/`artifact_outputs` of a subpipeline, `expose`, the
`artifacts` of a terminal, the `except[].result_var` of a try block, the
`items` of a map.

Dragging from a data output onto a node opens a "where to connect it" menu (a
stage argument — with the names from the spec suggested, the `inputs` of a
subpipeline, an artifact of a terminal). By default the wires do not all hang
on the canvas at once: the "View" menu switches three modes — hide the layer /
show the wires of the card under the cursor / show them all.

## Everything is done on the canvas

A node editor exists so that a graph is DRAWN rather than described in a form.
So every way of adding a node here ends with a connection, not with a card in
the middle of the canvas that has to be wired up afterwards:

| gesture | what happens |
|---|---|
| pull a wire from a port **onto a node** | the port is linked with that node |
| pull a wire **into empty space** | a "what to create here" menu → the node appears at the drop point already connected |
| **click** a port | the wire stays in hand until the next click: on a node it links, on empty space it creates; `Esc` lets it go |
| hover a link | `⊕` (insert a node into it) and `×` (cut it) appear on it |
| drag a node from the palette | onto a link it is inserted into it, onto a card it attaches to that card's free port, onto empty space it is created there |
| click in the palette | the node stands after the selected one; if there is nowhere to attach, in the centre of the view |
| double-click the background | a "create a node" menu at that place |
| middle button | panning the canvas (works over cards too) |
| right button | the selection marquee: everything it touched is selected as a group |
| `Shift`-click a node | add/remove the node from the selection |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | copy, cut and paste nodes — a paste lands under the cursor |
| `Delete` | delete the selection — a node, a link or a whole group |

While a wire is in hand the canvas hints at what is about to happen: the source
is outlined in the accent color, the target under the cursor is highlighted, and
a line hangs at the bottom edge (`then: click a node or empty space · Esc —
cancel`). Free ports are marked on the card with a hollow diamond — it is
visible where the graph can be continued without hovering the mouse.

Clicking a port (and not only dragging) is not there for beauty: a link across
half the canvas with the button held down is a miss on a touchpad, and between
two clicks one can scroll and zoom out. The handle of a wire is the whole port
slot rather than a 9×9 diamond: hitting a point with the mouse must not be part
of the work.

**A group selection** exists so that a graph can be rearranged and cleaned in
chunks rather than card by card: dragging any node of a group moves the whole
group by the same offset, `Delete` removes it entirely (the references to the
deleted nodes are scrubbed from everything that remains, and the redraw is one
for the whole deletion). The panel in that case shows not a node form — "five
nodes" have no common form — but the contents of the selection: a click on a
name narrows the choice to a single node and opens its ordinary form. A click
on a node of a group does not break the group up: otherwise it could not be
dragged — it collapses to a single node only if no dragging happened.

Panning moved to the middle button because the right one took the marquee and
the left one connecting; dragging the background with the left button remains
panning as well, so as not to break the habit. The system context menu on the
right button and the autoscroll on the middle one are disabled over the canvas
— both get in the way of the gestures.

**The creation menu** is one for every gesture: node types, then the registry
stages by category, with a search (the first character goes into the search,
`Enter` takes the first match, the arrows walk the list). What is meaningless
in that place is filtered out: `entry` is not offered as the target of a
transition (there is no going into the entry point) or as a second one in the
graph, `terminal` is not offered for insertion into an edge, because it has
nothing to continue the flow with.

**Insertion into an edge** (`⊕` on a link, a drop from the palette onto a link)
turns A→B into A→N→B, and the former target is picked up by the port through
which the new node continues the flow. That port is different for every kind
and declared by the node kind (`continuationKey`): for a stage it is `next`,
for a `condition` it is `then` (the main road), for a `try` and a `map` it is
`body` — a block is put there to protect what came next, a loop to repeat it,
neither to postpone it. So that the
inserted node covers nobody, the band of the canvas below the insertion point
is spread apart — both the tail of the chain and the unrelated nodes that
simply stood below move down.

What is attached "after" by a click in the palette is decided by the node kind
too (`appendKey`): an empty `parallel` needs a branch rather than the `next`
after the merge, an empty `switch` needs its first `case` rather than
`default`.

The wiring invariants are checked by enumeration over every node kind —
`node tests/wiring.mjs`: every kind has a port for the next node (except
`terminal`), a link really lands in the JSON, insertion into an edge keeps the
tail reachable, and the cards do not overlap after an insertion or an append.

## Regions

The nodes that own an area are framed with a label: the branches of a
`parallel`, the body of a `try` block and its `except` handlers, the body of a
`map` loop. It is visible
which nodes run inside and which run after leaving the area; nested blocks give
nested frames.

A `try` block has two areas, and they mean different things:

| frame | color | what is inside |
|---|---|---|
| `guard` | orange — the color of the node kind | the body: the nodes whose errors the block catches |
| `⚠ guard · except` | red `#e8697a` — the color of errors | the handlers: the nodes that only run when the body fails |

The emergency zone is marked separately because a single `except` arrow does
not show it: a handler drags a whole tail of nodes along (`fallback` in the
demo), and without a frame they read as an ordinary continuation of the branch.

The membership of a region is not in the JSON and should not be: it is derived
from the graph (`js/regions.js`) — the nodes reachable from the entries of the
area along order edges but not reachable from the exit point (the owner's
`next`). So an area cannot diverge from the structure: move an edge and the
frame is recomputed. The core computes the `scope` of a `try` block in exactly
the same way, so the frame in the editor shows precisely the nodes whose errors
the block will really catch.

A node type declares its area with the `regionEntries` method, and if it has
several areas with `regionGroups` (for `try` those are the body and the
`except` handlers) — a new node with an area can be added without touching the
canvas. The areas of one node do not intersect: a node reachable from both goes
to the first, that is, to the body. The layout puts the emergency zone to the
right of the main one — it has a bigger `rank`.

An area can be dragged by its label — all of its nodes move at once, without
disturbing the rest of the graph.

## Data wires: the nearest writer and the display mode

Data links are derived from the graph (`js/dataflow.js`), and derived more
carefully than "the names match, draw a line". The memory of StageFlow is a
shared scope: a reader sees not every write of a variable but **the last one
that happened before it in execution order**. So for every read the nearest
writers are looked for — a backwards walk over the order graph that stops at
the first writer of that name it meets. Branching gives several nearest ones,
one per path: which is honest, on different roads the value arrives from
different nodes.

The difference is not cosmetic: on a chain of 8 stages each of which reads and
overwrites `x`, "all pairs" gave 49 edges, the nearest writers give 7.

The implicit transitions that are not in the JSON are counted too: the merging
of `parallel` branches and the normal exit from a `try` body lead into the
owner's `next`. Without them the last node of a branch would not count as an
ancestor of whoever reads its variable after the merge (on the demo pipeline
that is 5 links out of 14). If there is no path in order at all — the node is
not connected yet — the link is drawn dashed: "the names match, the order is
undefined".

The display is switched in the "View" menu, three states:

| mode | what is on the canvas |
|---|---|
| `hide` | there is no data layer at all: neither wires nor rows on the cards |
| `focus` (default) | the wires appear when a card is hovered — only its own; the "arg ← var" rows on the cards stay |
| `all` | the former behaviour: every link at once, dimmed to opacity 0.3 at rest |

In any mode the whole path of a variable lights up when its row on a card is
hovered. The hidden edges stay in the SVG and are hidden by style, so neither
hovering a card nor highlighting a variable requires a redraw of the graph.

The "focus" mode is tied to the cursor rather than to the selection: the wires
are a piece of reference — "where it came from and where it goes" — one wants
to get it simply by moving the mouse over the graph, and not to lose it when a
node is selected for the inspector. The canvas tracks the cursor with a single
`pointermove` on the host: a redraw throws the cards out of the DOM, and a
`pointerout` from them would no longer arrive.

## The auto-layout: levels and columns

For files without saved coordinates (and on "View" → "Lay out again",
`Shift+L`) the layout works along the same axes as the connectors:

- **Y is the execution order**: the BFS depth over order edges, top to bottom.
- **X is nesting and data across the flow**: every area (the branches of a
  `parallel`, the body of a `try`, its `except`) gets a column of its own;
  inside a column a node stands under whoever handed control to it and steps
  aside to the right of its neighbours.

Writers move a reader to the right not always but only **across the control
flow**: if a writer stands above a reader on the execution path (counting the
implicit exits from areas — the merge of a `parallel` and the normal end of a
`try` body), their wire already reads top to bottom and there is no need to
spread the nodes horizontally. While the rule was unconditional, a chain of
"everyone reads the previous one" walked off like a staircase: in a demo
pipeline of 15 nodes the graph stretched to 1510 px horizontally instead of
810, and `report` and `done` flew off into the bottom-right corner.
Reachability is computed by `controlSuccessors()` from `dataflow.js` — the same
transition graph the nearest writers are searched over.

The column of an area is not decoration but a **guarantee**: the frame is drawn
around the bounds of its own nodes, so an unrelated node that falls inside that
rectangle looks like part of it, as if the `try` caught its errors too. While X
was handed out by a common packing per level, strangers regularly ended up
inside — most often the `except` handlers: they stand at the level of the block
body but are not part of the area. Separating them afterwards does not work: on
nested areas the pushing-out loops forever (two neighbouring areas chase each
other's nodes to the right without stopping). Columns rule that out by
construction — a node lies in the column of its own area and in nobody else's.

The column of a block stands **to the left** of the foreign nodes on its
levels: a block is the main road, and the body of a `try` should read before
its `except` handlers rather than hide behind them. The handlers step aside to
the right of the frame.

Columns do not waste width: one only has to move aside from the areas one
overlaps **vertically** — on foreign levels their frame is not there. So
several blocks that follow one another occupy the same column, and the graph
does not drift right with every `try` in a chain.

The merge point of a `parallel` is forcibly pushed below every node of its
branches: otherwise the BFS would put it on the same level as they are and it
would land inside the region frame, although it runs after the branching.

The invariants are checked by enumeration — `node tests/layout.mjs`: 291 random
graphs (up to 122 nodes, with nested `parallel` and `try`), not one foreign
node inside a frame, not one overlap of cards, and laying out again moves
nothing.

The gaps leave room for the order arrows to bend. They used to be three times
wider — for the data wires, which hung on the canvas all at once; now those
wires are shown on focus, and there is no need to reserve half the canvas for
them. The density is configurable:

```js
createEditor(container, { spacing: { gapX: 110, gapY: 120, dataGap: 130 } }); // the default
```

`fitView` does not shrink below 0.62: a large graph is better shown big and
partly than whole but as unreadable porridge. When a graph does not fit, the
view stands at its beginning (the entry) rather than at the middle of its
bounds.
