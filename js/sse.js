/**
 * Reading a server-sent event stream with `fetch` instead of `EventSource`.
 *
 * `EventSource` is the obvious tool and was the one used here, until the
 * editor learned to carry a credential: **it cannot send headers**. Not "it
 * is awkward to" — the constructor takes a URL and nothing else, which is a
 * decision of the platform and not one there is a way round. The usual
 * workaround is to put the token in the query string, where it ends up in
 * access logs, in the referrer and in the history of whoever is screen-
 * sharing. So the stream is read by hand: `fetch` takes headers like every
 * other request, and the credential is attached in exactly one place
 * (`Backend.fetch`) rather than in one place plus an exception.
 *
 * What is given up is the automatic reconnect, and it is replaced with a
 * better one: `?from=N` resumes at the event after the last one seen, so a
 * connection that broke mid-run does not lose the events it missed — which
 * is what `Last-Event-ID` would have had to be wired up for anyway.
 *
 * The parser is the SSE wire format and only the part of it that is used:
 * frames separated by a blank line, `data:` lines concatenated, everything
 * else (a `: keep-alive` comment, a `retry:`) ignored.
 */

const RECONNECT_MS = 1000;
const RECONNECT_TRIES = 5;

export class EventStream {
  #abort = null;
  #closed = false;
  #tries = 0;

  /**
   * @param url     where the stream is; `?from=` is appended when resuming
   * @param fetcher `(url, init) => Promise<Response>` — `Backend.fetch`, so
   *                that the credential comes along
   * @param onEvent called with each parsed event object
   * @param onError called when the stream is given up on for good
   * @param from    which event to start at (0 — from the beginning)
   */
  constructor(url, { fetcher = fetch, onEvent, onError = null, from = 0 } = {}) {
    this.url = url;
    this.fetcher = fetcher;
    this.onEvent = onEvent;
    this.onError = onError;
    // the next event we have not seen; also where a reconnect resumes
    this.next = from;
    this.#run();
  }

  close() {
    this.#closed = true;
    this.#abort?.abort();
    this.#abort = null;
  }

  async #run() {
    while (!this.#closed) {
      try {
        await this.#read();
        // the server closed the stream: the run is over, not a failure
        return;
      } catch (err) {
        if (this.#closed || err?.name === "AbortError") return;
        if (++this.#tries > RECONNECT_TRIES) {
          this.onError?.(err);
          return;
        }
        await new Promise((done) => setTimeout(done, RECONNECT_MS));
      }
    }
  }

  async #read() {
    this.#abort = new AbortController();
    const separator = this.url.includes("?") ? "&" : "?";
    const url = this.next ? `${this.url}${separator}from=${this.next}` : this.url;
    const response = await this.fetcher(url, {
      signal: this.#abort.signal,
      headers: { Accept: "text/event-stream" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error("the stream has no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      // a reconnect that succeeded is not a run of bad luck any more
      this.#tries = 0;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + (buffer[end] === "\r" ? 4 : 2));
        this.#frame(frame);
        if (this.#closed) return;
      }
    }
  }

  #frame(frame) {
    const data = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith(":") || !line.includes(":")) continue; // comment, keep-alive
      const [field, ...rest] = line.split(":");
      if (field === "data") data.push(rest.join(":").replace(/^ /, ""));
    }
    if (!data.length) return;
    let event;
    try {
      event = JSON.parse(data.join("\n"));
    } catch {
      return; // not ours; a stream may carry frames this editor knows nothing of
    }
    // the event number is in the event itself, which is what makes a resume
    // exact rather than approximate
    if (typeof event.index === "number") this.next = event.index + 1;
    this.onEvent?.(event);
  }
}
