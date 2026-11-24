/**
 * Reading a server-sent event stream with `fetch` instead of `EventSource`.
 *
 * `EventSource` cannot send headers, so it cannot carry a credential; the
 * usual workaround, a token in the query string, leaks it into logs and the
 * referrer. `fetch` takes headers like every other request, and the
 * credential is added in one place (`Backend.fetch`).
 *
 * Reconnecting is done by hand: `?from=N` resumes after the last event seen,
 * so nothing is lost when a connection drops mid-run.
 *
 * Only the part of the SSE format that is used is parsed: frames separated by
 * a blank line, `data:` lines joined, everything else (comments, `retry:`)
 * ignored.
 */
import { t } from "./i18n.js";

const RECONNECT_MS = 1000;
const RECONNECT_TRIES = 5;

export class EventStream {
  #abort = null;
  #closed = false;
  #tries = 0;

  /**
   * @param url     the stream; `?from=` is added when resuming
   * @param fetcher `(url, init) => Promise<Response>`, usually `Backend.fetch`
   *                so the credential is sent
   * @param onEvent called with each parsed event
   * @param onError called when reconnecting has been given up
   * @param onClose called when the server ended the stream; whether that is
   *                expected (a run finished) only the caller knows
   * @param from    the first event to read (0: from the start)
   */
  constructor(url, { fetcher = fetch, onEvent, onError = null, onClose = null, from = 0 } = {}) {
    this.url = url;
    this.fetcher = fetcher;
    this.onEvent = onEvent;
    this.onError = onError;
    this.onClose = onClose;
    // the next unseen event; a reconnect resumes here
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
        // the server closed the stream; for a run that is normal, so whether
        // it matters is up to onClose
        if (!this.#closed) this.onClose?.();
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
    if (!response.body) throw new Error(t("sse.noBody"));

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      // a successful reconnect resets the retry count
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
    // events carry their index, so resuming is exact
    if (typeof event.index === "number") this.next = event.index + 1;
    this.onEvent?.(event);
  }
}
