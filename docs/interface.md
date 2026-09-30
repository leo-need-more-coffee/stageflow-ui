# The interface

## The menu bar: sections instead of a row of buttons

The top bar used to hold fourteen controls of four different meanings — file,
edit, view, run — and finding the right one meant reading the whole of it: the
buttons `↶` `↷` `⤢` `⇲` `ⓘ` were grouped by nothing, and half of them were
labelled with a glyph. Now there are four sections — **"File", "Edit", "View",
"Run"** — plus the graph selector and the run state. The meaning is visible
from the section name, and the items themselves are labelled with words and
carry the hotkeys, so the bar stops being the only way to reach them.

The sections are opened by **the same menu the canvas uses** (`menu.js`): a
dropdown built from a different set of primitives would look foreign in this
interface. Hence `shortcut` in the items (the key on the right), `checked` (a
tick for toggles), `disabled`, and separators with group headings. The
behaviour is that of a menu bar everywhere: an open section switches on hover
to a neighbouring one (otherwise every move is a close and an open), and a
click on an open section closes it, but only if it was opened BY A CLICK —
otherwise the menu would slam shut on the very press meant to pin it.

Three things without which a menu bar stays "a list of buttons in another
wrapper":

- **The keyboard gets all the way through.** Focus is held by the menu root
  rather than by the first button: the first item is sometimes disabled (in
  "Edit" on a clean graph all of them are), and the browser will not focus such
  a button — the keyboard would die before it started. The up/down arrows step
  over separators, headings and disabled items (otherwise the list stops at the
  very first separator), left/right move to the neighbouring section in a
  cycle, and `Esc` closes and returns focus to the section button — so that
  leaving a menu does not mean "now pick up the mouse".
- **The items are updated in place.** The bar is redrawn on every change, and
  during a run the events come in batches. An open section survives that: the
  menu moves to the new button and replaces the items, keeping the cursor
  position in the list. Otherwise "Run" would slam shut under the hand or show
  a state that no longer exists ("Step" disabled while the session already
  stands on a node).
- **Toggles come as a set, not as a cycle.** The data layer ("hide" / "for the
  card under the cursor" / "all at once") and the run pace ("no delay" up to
  "2 s") are items with a tick under a common heading. One item that cycles, in
  a menu that closes after a choice, would mean opening it three times to reach
  the far mode. The tick then takes up room in every item of such a menu, or
  the labels would jump horizontally when moving from group to group.

The hotkeys the editor listens to itself (the menu items show them so that they
get learned):

| keys | action |
|---|---|
| `Ctrl+Z` / `Ctrl+Shift+Z` (`Ctrl+Y`) | undo / redo an edit |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | the node clipboard |
| `Delete` | delete the selection (a node, a group, a link) |
| `Esc` | clear the selection; in a menu — close it |
| `Shift+F` / `Shift+L` | fit the graph to the screen / lay it out again |
| `F5` / `Shift+F5` / `F10` | run / debug step by step / step |

The letter is taken from `event.code` rather than from `event.key`: on a
non-Latin layout `key` gives a letter of that alphabet, and `Ctrl+Z` would stop
working exactly where the editor is used. Inside an input the combinations are
not intercepted — there `Ctrl+Z` is an undo of the typing, the browser's
business.

## The inspector: a panel from the spec, not from the JSON

The panel answers questions in the order in which a node is thought about, and
hides the bookkeeping:

| section | what is inside |
|---|---|
| no heading | the main field of the node kind: the stage, the condition, the branches, the handlers |
| **What it gets** | a row per argument **declared by the stage spec** |
| **What it gives** | a row per result field: a "save it" checkbox plus the variable |
| **Next** | the order ports of the node (`next`, `then`/`else`, `body`, `default`) as node lists |
| ▸ More | the node name, entry, `retry`, `consume`, `expose`, foreign keys |

An unfinished row of a table editor lives in the panel as a **draft** rather
than in the JSON: an empty row cannot be represented in JSON (no variable name,
no `when` of a case), and without drafts the "+ row" button would look like
"nothing happened". The columns can be filled in any order — the row goes into
the JSON once it becomes complete.

For an `entry` node the "What it gives" section is the table of the variables
the pipeline starts with: the name, "value / expression", the value itself.
This is the only place where a variable is introduced by the pipeline rather
than by a stage.

The key difference from the former form: the input and output rows come **from
the spec**, not from the node JSON. The stage said itself what its arguments
are — name, type, whether it is required, description — and the panel shows
them all at once; what is left for the user is to fill them in rather than to
guess and create a table row by hand. What is not declared (someone else's
pipeline, a stage without a docstring) is collected below in a separate group —
nothing gets lost.

Three things that fixes:

- **The source of a value is chosen in words.** Instead of a `vars / const /
  cel` select — "variable / value / expression". The scope selector disappeared
  from the panel altogether: the `global` scope was removed from the memory
  model of the core, so a variable is always a frame variable and the editor
  has nothing left to ask about it. The value control itself follows the type
  from the spec: a checkbox for `bool`, a number field for numbers, and for a
  list or an object a text field with JSON parsing and a hint of the shape.
- **A variable name is picked, not typed.** The list of existing names comes
  from `variablesOf()` in `dataflow.js`, so a typo no longer silently creates a
  second variable.
- **An unfilled required argument is visible at once**: the row is outlined in
  red, and the same error goes to the status bar with the same text. An output
  the stage does not return is marked the same way: an `outputs` key is the
  name of a result field, and an invented name is a guaranteed
  `StageOutputError` at run time, so the row turns red and says plainly what
  the stage actually gives.
- **What the pipeline does not define cannot be invented.** The contents of a
  stage result are set by its code, so when a stage has declared its outputs
  the button offers not "your own field" but "a variable from an expression" (a
  key with `.$`): its name is chosen by the pipeline author, its value is
  computed by the expression, and the stage has nothing to do with it. That way
  one node introduces as many variables as needed. A result field is typed by
  hand only when the contract is unknown — a stage without a docstring or with
  a `*`. The check is unambiguous because an argument has exactly one source:
  a stage has no second input channel (the node's `config` field was removed,
  a literal setting is a `const` argument), so "empty, but perhaps it comes
  from the settings" no longer happens.

The expression fields of the node kinds themselves — the `condition` of a
`condition`, the `when` of a case, the `items` of a loop — are filled the same
way, with the same three sources. The core evaluates them with CEL and accepts
nothing else, so unlike a stage argument they cannot keep the source as a shape
in the JSON: `celSource()` reads it back out of the text (`vars.x` is a
variable, `["a","b"]` is a value, anything else is an expression) and
`celExpr()` writes it in. Until then the only way to walk a list was to type
`vars.` by hand, and a ready-made list could not be said at all. A dropped
variable lands in them too: on a `condition` it becomes the condition, on a
`switch` a new branch.

Such a field has the same four states a stage argument has, "not set" included,
and picking **variable** on an unnamed one binds it to a variable named after
the field (`items \u2190 items`) — the same default `parts \u2190 parts` is. That
is not cosmetics: until the JSON names a variable the card grows no port, and a
port is what a wire is attached to. The label of the port names the field, so
what it feeds is visible on the card rather than only in the panel.

One thing the panel has to remember for this: the source picked by hand.
`vars.count` on the way to `vars.count > 0` reads as a bare variable — without
remembering, "expression" snapped back to "variable" mid-typing. The choice
holds while the text still fits it; an expression fits any text and holds until
it is changed back by hand.

The port labels in "Next" are human (`if yes` / `if no` / `block body`), with
the JSON key next to them in small type, so that the format is still visible.
The list of ports is assembled by the inspector from `orderPorts()`, so a node
kind does not have to duplicate `then`/`else`/`next` as separate fields — for
`condition`, `try` and `switch` those fields are removed from `fields()`.

The section is set by the `group` field of a descriptor (`main` / `in` / `out`
/ `more`), the order by the `GROUPS` constant in `js/inspector.js`.

## With nothing selected: the variable index

The same panel with no selection used to hold a catalogue of canvas gestures —
eleven lines of instructions in the one place a reader has already stopped
looking for them. They are still written down, folded away at the bottom
("how to assemble a graph"), and the space belongs to the graph itself: how many
nodes and links it has, which node it starts at (a button — that is the first
node anybody looks for), and the list of its variables.

The index is the thing the canvas cannot show on its own. The memory of
StageFlow is a shared frame, so a variable is not a wire between two cards but a
name, and on the canvas that name is scattered over as many rows as there are
nodes touching it. Gathered into one list, `name — who writes it → who reads
it`, it also shows the two mistakes nothing else catches: a variable **nobody
writes** (marked in red: the reader will get nothing) and one **nobody reads**
(the write is dead weight). Neither is invalid JSON, so validation is silent
about both, and both are ordinary while a graph is half-assembled — which is why
they are a mark in a list rather than an error in the status bar.

Hovering a line lights that variable's path on the canvas — the same highlight
hovering a row on a card gives, from the other end (`highlightVariable()` on the
canvas, reached through `env.highlightVar`). Together with the colour of the dot,
which is the colour of that variable's wires, the panel reads as a legend to the
picture. A node name in the list is a button: it selects that node, and the
panel turns into its form.

## What makes a node recognisable

Five independent signs, so that a node reads at a glance without opening the
inspector:

- **The icon** from the stage docstring — a glyph (`icon: "＋"`, a character or
  an emoji), **a link to an SVG file** (`icon: "/icons/globe.svg"`,
  `https://…`), a data URI, or inline `<svg>` markup. The `icon_mono: true`
  flag paints the SVG in the node color (for sets like lucide/feather built on
  `currentColor`), without it the picture keeps its own colors. If there is no
  icon or the link is broken — a monogram of the name (`IncrementStage` →
  `IS`), so that stages are always distinguishable. Node types have glyphs of
  their own: `▶` entry, `?` condition, `⑂` switch, `⇉` parallel, `▣`
  subpipeline, `⛑` try, `⟲` map, `◉` terminal.

  Foreign SVG never reaches the DOM as markup — only as an `<img>` or a CSS
  mask (`js/icons.js`), so an icon from a third-party stage registry cannot
  become XSS; `javascript:`-like values are shown as text. An absolute path is
  fetched from the backend that declared it (see [The backend](backend.md)),
  not from the editor's own origin.
- **The color** — from the docstring (`color: "#ff8800"`) or the deterministic
  color of the stage category: every `builtin.lists` in one hue,
  `builtin.logic` in another. It paints the icon tile, the order inlet and the
  palette row.
- **The description** — the stage `description` under the card title, two
  lines. Switched off in the "View" menu ("Stage descriptions on the cards").
- **Behaviour badges** in the header: `↻` retry, `✂` consume, `⇄` expose — what
  is otherwise visible only in the inspector.
- **Value settings** as `argument = value` rows (`url =
  https://example.com/api`, `delta = 10`, `ƒ 2 + 2` for an expression without
  variables). They have no connector and cannot have one — the source of these
  values is the pipeline itself, not another node — so the row is paler and has
  no dot. But they have to be seen: a `fetch` without its `url` shown is "some
  request somewhere", for which the panel has to be opened anyway. A long value
  is trimmed (the full one is in the tooltip), and a list of settings longer
  than six rows is folded into "N more": a card's job is to show, not to fit
  everything. A value of spaces and an empty string are shown in quotes
  (`separator = " "`), or they would look like "nothing is set". The rows stand
  between the reads and the writes — they are arguments, their place is next to
  the inputs.

Hovering a variable row highlights the whole path of that variable through the
graph: the edges of that variable light up, the rest of the graphics goes out.

## The theme

The styling is cold graphite where depth comes from tone rather than from
shadows — the canvas `#0b0d11` darker than the panels `#12151b`, the panels
darker than the cards `#171b22`, the input fields `#0f1216` darkest of all. The
borders are white with a low alpha (`0.07` for separators, `0.12` for cards),
one turquoise accent `#3fcbae` for the whole interface, Manrope for the labels
and IBM Plex Mono for identifiers, variable names and code (the fonts are
linked in `index.html`; offline the system fallbacks from `--ui` / `--mono`
take over).

A color means the same thing everywhere — on a card, in a port and in the
inspector:

| color | meaning |
|---|---|
| green `#4ecb86` | a variable write, the `next` transition, "the graph is valid" |
| amber `#e8b85c` | a variable read, the `then` branch |
| red `#e8697a` | validation errors, `except` handlers |
| violet `#8e8ce8` | `parallel` and its area |
| orange `#e8935c` | `try` and its area |
| turquoise `#3fcbae` | the selection, active modes, accent buttons |

The dot of an order outlet is painted by `portColor()` in `canvas.js` from the
meaning of the port, the arrow in a data row by CSS from its direction
(`.sf-row-datain` / `.sf-row-dataout`). So "where it goes" and "where it came
from" are visible without reading the text of the row.

## The language

The interface's text lives in `i18n/<tag>.json` — a flat `{key: string}`
catalog per language — and the languages on offer are the keys of
`i18n/index.json`, each named in its own language. Nothing in the code names a
language except the fallback (`en`, the language the keys were written in), so
adding a language is adding a file and a line, without touching the editor.

The choice is an item with a tick under "Language" in the "View" section. What
the reader gets is decided in this order: `?lang=ru` in the address, then the
choice they made here last time, then what the browser asks for — a link
somebody was handed outranks a saved choice, and a saved choice outranks the
browser, which is the right default only until there is a choice to respect.
`ru-RU` finds the `ru` catalog, so a regional tag needs no file of its own.

Two catalogs are held at once, the chosen one and the fallback, so a
half-finished translation reads as English where it is unfinished rather than as
`toolbar.file`; a key that is in neither is drawn as itself and complained about
in the console — obvious while developing, harmless to a reader. Plural forms
come from `Intl.PluralRules`, which knows that Russian has three and English
two, so a count is never glued to a bare noun.

## The session: undo, panels, reloads

The editor is a workplace rather than a demonstration, so the state survives
both a mistake and a closed tab:

- **Undo and redo.** `Ctrl+Z` undoes an edit, `Ctrl+Shift+Z` (or `Ctrl+Y`)
  brings it back; the same actions are in the "Edit" menu, where they go out
  when there is nothing to rewind. The history is snapshots of the pipeline
  JSON (a hundred steps), and it holds exactly the steps the user made: the
  `change` event is also sent by actions that do not change the pipeline —
  switching a subpipeline, redrawing after the specs load — so a record is
  compared with the head of the history, or `Ctrl+Z` would click idly. Undoing
  an edit made in a subpipeline returns into that subpipeline as well:
  otherwise it would be undone "somewhere not here". Inside an input `Ctrl+Z`
  is not intercepted — there it is an undo of the typing, the browser's
  business.
- **The node clipboard.** `Ctrl+C` copies the selection, `Ctrl+X` cuts, `Ctrl+V`
  pastes — under the cursor if it is over the canvas, otherwise offset from the
  originals; what was pasted becomes the selection at once, because a copy is
  almost always moved right away. The danger of pasting is not in duplicating
  JSON but in the references: inside the pasted set they move onto the copies
  (otherwise a copy of a branch would control the original), an outward
  reference is kept if such a node is in the graph and cleared if it is not (a
  paste into another subpipeline). A second `entry` is not pasted — there is
  one entry point per graph. The buffer is internal: it does not reach into the
  system clipboard, but in exchange pasting does not depend on browser
  permissions.
- **The panels fold** by the handle on their own edge — where one looks when a
  panel is in the way; in the place of a folded one the same narrow rail stays,
  and bringing the panel back is exactly as easy. On a narrow screen the
  palette and the inspector eat the very canvas everything is about. A folded
  node panel unfolds by itself when a node is selected: a click on a card would
  otherwise look like "nothing happened". It does not fold back — that is the
  user's decision, not a consequence of a click.
- **A reload resets nothing** if `storageKey` is set: the pipeline, the current
  subpipeline, the view (pan and zoom) and the panel layout go into
  `localStorage`. A restored graph at someone else's zoom still reads as "it
  reset itself", so the view is saved together with the graph and the first
  `fitView` is not performed on a restored session. The write is deferred
  (editing a graph is dozens of events in a row) and is silently skipped if the
  storage is unavailable: private mode and a quota are no reason to bring the
  editor down.

The history invariants are checked separately — `node tests/history.mjs`: idle
events do not get in, a new edit cuts off the undone branch, an undo restores
the coordinates and the graph, and loading another pipeline starts the history
over. Pasting is checked by `node tests/clipboard.mjs`: the references inside a
set move onto the copies, the outward ones are kept or cleared depending on the
target, no second `entry` appears, and `Ctrl+Z` removes the whole paste in one
step.
