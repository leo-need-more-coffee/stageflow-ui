# Building a graph

## Two sorts of connectors — on two axes

The memory model of StageFlow is a shared scope: a variable is not "a wire from
A to B", it lives in the frame and is read by any node further down the path.
So the editor shows order and data separately, on different axes, so that the
two layers do not get confused by the eye:

```
                 ▪  order inlet (top edge)
        ┌──────────────────────┐
     ▪──│ id                   │
        │ StageName            │
        │ text ← text          │      data: horizontal,
        │       topic → topic  │──▪   reads left, writes right
        ├──────────┬───────────┤
        │   next   │   else    │
        └────▪─────┴─────▪─────┘
             ▼ order: vertical
```

**Order connectors** are **vertical**: the inlet at the centre of the top edge,
the outlets as a bar along the bottom one, each labelled with its road (`next`,
`then`/`else`, `cases[].next`, `branches[].entry`, `try.body`, `except[].next`,
`map.body`, `on_timeout`). These are the real edges of the JSON, drawn top to
bottom with an arrowhead. The `+ case` / `+ branch` / `+ except` outlets create
a list item together with its link. A card widens when it has more outlets than
fit.

**Data connectors** are **horizontal**: what a node reads on the left edge
(`text ← text`), what it writes on the right (`topic → topic`). There are no
data edges in the JSON: they are derived from the graph — from the nearest
writer of a variable to its reader (see below) — and drawn in that variable's
own stable colour. Literal arguments have no connector; they are rows of their
own on the card (`delta = 10`).

The less obvious reads count too: `vars.x` (and `vars['name']`) inside CEL —
`condition`, `when`, arguments with `.$`, the variables of an `entry` — the
`inputs` and `artifact_outputs` of a subpipeline, `expose`, the `artifacts` of a
terminal, the `except[].result_var` of a try, the `items` of a map.

## Everything is done on the canvas

A node editor exists so that a graph is drawn rather than described in a form,
so every way of adding a node ends with it connected:

| gesture | what happens |
|---|---|
| pull a wire from an outlet **onto a node** | the outlet is linked to it |
| pull a wire **into empty space** | the add menu opens there; the node appears at the drop, already connected |
| hover an order wire | a **+** on it inserts a node into the wire |
| **+ Add node** or `A` | the add menu; the new node goes next to the selected one |
| double-click the background | the add menu at that place; inside a subpipeline's frame the node goes into that subpipeline |
| drag the empty canvas | a selection box |
| `Shift`/`Ctrl`-click a node | add it to the selection or take it out |
| wheel, touchpad, middle button, `Space`+drag | pan; `Ctrl`+wheel or a pinch zooms |
| right-click a node | duplicate, copy, cut, make it the entry, delete |
| click a wire, then `Delete` | cut it |

**The add menu** is a finder rather than a list, because a backend may have
hundreds of stages. Categories on the left, matches in the middle, the
highlighted one's spec on the right. The search matches a whole name, a part
of one (`customer` finds `LoadCustomerStage`), initials (`lcs`), an argument
name, a category or a description, ranked in that order; stages used recently
come first. What makes no sense in that place is left out: `entry` as the
target of a wire, `terminal` inserted into a wire. A node kind the backend
cannot run is shown greyed out, with the reason.

**Insertion into a wire** turns A→B into A→N→B, and the former target is picked
up by the port through which the new node continues (`continuationKey`): `next`
for a stage, `then` for a condition, `body` for a try or a map — a block is put
there to protect what came next, a loop to repeat it. The band of the canvas
below is spread apart so that the new node covers nobody.

**A selection** moves together and is deleted together; references to deleted
nodes are scrubbed from what remains.

**A drag is drawn as it happens.** The card follows the hand, its wires follow
the card, and the frame of a loop or a try grows and shrinks around it on every
step rather than on the drop. While a card is dragged, the data wires shown
are its own: passing over other cards does not flick theirs on and off. The
drop is one undo step.

**When an agent edits the graph** over the [bridge](bridge.md), the change
grows on the canvas rather than popping in: new cards fade in, new wires are
drawn along their length, moved cards glide, and the view goes to the newest
part. With "reduce motion" on in the system, all of that is off.

The wiring invariants are checked over every node kind by
`node tests/wiring.mjs`: every kind but `terminal` has a port for the next
node, a link really lands in the JSON, inserting into a wire keeps the tail
reachable, and cards do not overlap after an insertion.

## Regions

The nodes that own an area are framed with a label: the branches of a
`parallel`, the body of a `try` and its `except` handlers, the body of a `map`.
It is visible which nodes run inside and which run after the block; nested
blocks give nested frames.

A `try` has two areas, and they mean different things: the body, in the kind's
colour, holds the nodes whose errors the block catches; the handlers, in the
colour of errors, hold the nodes that run only when the body fails. A handler
drags a whole tail of nodes along, and without a frame they would read as an
ordinary continuation.

Membership is not in the JSON and should not be: it is derived from the graph
(`src/core/regions.js`) — the nodes reachable from the area's entries along
order edges but not from its exit (the owner's `next`). So a frame cannot
disagree with the structure; the core computes a try's scope the same way.

**A frame is a rectangle, and a graph is not.** A node that does not belong to
a block can still be dragged onto its frame, and then it reads as part of the
block whatever the graph says. Such a card is outlined apart and labelled
**not in `<block>`**, with a hint to drag it out; the mark comes and goes while
dragging. The order wire leading out of a block normally goes around the
block's body rather than under its cards; when its target sits inside the frame
like this, there is nothing to go around, and it takes the plain curve.

## Subpipelines beside the graph

**Graph switcher → Subpipelines beside the main graph** draws every subpipeline
in a frame next to the main graph, with a dashed line from each node that calls
it. The frame is a graph of its own, edited in place: clicking a node in it
makes that subpipeline the one being edited — the inspector, undo, delete and
paste work on it — and double-clicking inside it adds a node to it. A frame is
moved by its header; the **⤢** button opens the subpipeline alone. Turned off,
the switcher goes back to one graph at a time.

## Data wires: the nearest writer and the display mode

A reader sees not every write of a variable but **the last one before it in
execution order**, so for every read the nearest writers are looked for — a
walk backwards over the order graph that stops at the first writer of that
name (`src/core/dataflow.js`). Branching gives several nearest writers, one per
road. On a chain of 8 stages each reading and overwriting `x`, "all pairs"
would give 49 wires; the nearest writers give 7.

The implicit transitions count too: the merge of `parallel` branches and the
normal exit of a `try` body lead into the owner's `next`. When there is no
order between two nodes at all — one is not connected yet — the wire is dashed:
the names match, the order is undefined.

How many wires are on the canvas is chosen in the command palette (`Ctrl+K`,
"wires"):

| mode | what is on the canvas |
|---|---|
| off | no data layer: no wires and no rows on the cards |
| focus (default) | the wires of the card under the cursor and of the selected ones |
| all | every wire at once, the unfocused ones dimmed |

In any mode, hovering a variable in the variable index lights its whole path up.

## The auto-layout: levels and columns

For a file without saved coordinates (and on `Shift+L`) the layout works along
the same axes as the connectors:

- **Y is execution order**: the depth over order edges, top to bottom.
- **X is nesting and data across the flow**: every area gets a column of its
  own; inside a column a node stands under whoever handed control to it.

A writer moves its reader to the right only **across** the control flow: when
the writer is above the reader on the execution path, their wire already reads
top to bottom. While the rule was unconditional, a chain of "each reads the
previous one" walked off like a staircase.

The column of an area is a **guarantee**: a frame is drawn around its own
nodes, so an unrelated node inside the rectangle would look like part of it.
Columns rule that out by construction, and they do not waste width — an area
steps aside only from the areas it overlaps vertically, so blocks that follow
one another share a column. The merge point of a `parallel` is pushed below
all of its branches.

`node tests/layout.mjs` checks this on 291 random graphs of up to ~120 nodes
with nested `parallel` and `try`: no foreign node inside a frame, no two cards
overlapping, and laying out again moves nothing.

The density is an option:

```js
createEditor(container, { backend, spacing: { gapX: 110, gapY: 120, dataGap: 130 } }); // the default
```

Opening a graph fits it to the screen unless that makes it unreadable: below
60 % the top of the graph is shown at 80 % instead, and the rest is a scroll
away. A run moving on to a node off screen brings it into view.
