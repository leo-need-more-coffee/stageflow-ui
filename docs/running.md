# Running and debugging

A pipeline is run straight from the editor: "Run" → "Run" (`F5`) drives it to
the end, "Debug step by step" (`Shift+F5`) stops before the very first node and
goes on by command (`F10` is a step). The debug panel opens at the bottom: the
status, the current node, step/pause/stop, the delay between nodes, the frame
variables and the event log. The graph shows where execution is: the current
node pulses in the accent color (or glows amber when stopped), the passed ones
are marked with a green frame.

## The pace is set before the start

Without a delay a pipeline finishes before the eye can follow its path through
the graph: the nodes all flash at once, and "what is going on" is only visible
in the log. Stepping by hand shows it honestly, but talking about a pipeline
while pressing `F10` on every node is awkward — so between "instantly" and "a
node per keystroke" there is a pace one simply watches: a pause between nodes,
held by the core (`StepDebugger(delay=…)`) rather than by a timer in the
browser, so it does not drift apart from the real execution.

The pace is chosen in three places, and all three are one value
(`Editor.runDelay`, which survives a reload): the "Delay between nodes" group
in the "Run" menu, the "pace" row in the run dialog — right where the starting
variables are entered — and the field in the debug panel. In the dialog it is a
FIELD rather than a list: the ready-made values sit in the field's dropdown,
but for a particular talk the pace is chosen by ear ("three seconds a node,
otherwise I cannot keep up"), and running into someone else's list where a
number simply has to be typed is a needless obstacle. A fraction is accepted
with a dot as well as with a comma; a typed pace is shown in the menu as an
item of its own with a tick, or the current value would look like "none". The
field in the panel changes the pace of a RUNNING session: "too fast, I did not
get to explain" is discovered in the middle of a demonstration rather than
before it, and there is nothing to restart for that.

## Starting variables

**Before a run the editor asks for the starting variables** — they are declared
by the `entry` node, and declared as DEFAULT VALUES: a name that arrived from
outside is neither overwritten nor even evaluated by the node. So "run it with
a different `n`" is a run with arguments rather than an edit of the JSON, and
they have to be asked for exactly where the run is started. In the dialog an
empty field means "as in the pipeline": the declared value stands as a
placeholder rather than as text — so both what will happen by default and what
was overridden are visible, and a computed variable (`total.$`, marked
"expression") cannot be wiped by accident. A row below lets an own variable be
added that is not in `entry` at all. What was entered is remembered for the
next run (and survives a reload), the "↻" button in the panel repeats the run
with the same arguments without asking, and loading another pipeline forgets
the arguments — they belonged to the previous graph.

## It is the core that executes, not the editor

The semantics (CEL, types, `try`/`except`, `parallel`, frame merging) live in
StageFlow; a second implementation in JavaScript would mean the debugger shows
something other than what actually happens. So the editor is a client of the
run API on the backend, and a run happens there in a real `Session` with the
core debugger (`StepDebugger`).

**Variables can be not only watched but edited** — right in the panel, while
the session is stopped. An edit is applied before the next node (in the middle
of a step a node would see half of it) and checked against the declared types:
a mismatch is rejected with a `var_rejected` event rather than by failing the
run. That is how branching is tested: set `n = 10` before a `condition` and the
pipeline takes another road without the JSON being rewritten.

**The delay between nodes** (the field in the panel, milliseconds) is "watch it
go" without stepping by hand: the session waits before every node, so the
highlight has time to show the node that is executing rather than the one that
has already passed.

In a graph with a `parallel` a step looks unusual: the branches run at the same
time, so the debugger stands on several nodes at once, and `⏭` releases the one
whose turn came first. The log in that case honestly shows several `paused` in
a row — those are not duplicates but different branches.

## The run API

The backend gives the same thing over HTTP — the editor can do nothing beyond
this (see [The backend](backend.md)):

```
POST   /api/run                {pipeline, vars, mode: "run"|"step", delay} -> {id, state}
GET    /api/run/<id>           the state of the run
GET    /api/run/<id>/events    the event stream (SSE), ?from=N — read on from the Nth
POST   /api/run/<id>/control   {action: "step"|"resume"|"pause"|"stop"|"delay", count, delay}
POST   /api/run/<id>/vars      {set: {...}, drop: [...]}
```

The events of the stream: `node_enter` / `node_exit` with the frame, `paused`,
the session telemetry (`stage_started`, `stage_failed`, `condition_evaluated`,
…), `var_set` / `var_rejected`, and at the end `finished` with the result and
the artifacts, or `failed`. Every event has an `index`, so an interrupted
stream is read on from where it broke (`?from=N`) instead of starting over.

The state is assembled from the stream rather than by polling: a debug step is
an event, and "the node started" must appear on the graph when it happened. The
commands go as ordinary POSTs: they are initiated by the user, and their answer
is not needed before the event.
