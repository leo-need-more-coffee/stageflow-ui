/**
 * A popup menu: a list of actions with a search and keyboard control.
 *
 * The same menu is opened both by the canvas ("what to create here") and by the
 * toolbar menu bar ("File", "Edit", "View", "Run") — deliberately the same one:
 * a dropdown built from a different set of primitives would look foreign in
 * this interface. Hence `shortcut` in the items (the hotkey on the right),
 * `checked` (a tick for toggles), `disabled`, and separators with group
 * headings.
 *
 * It is needed where the choice happens UNDER THE CURSOR and continues a
 * movement already begun: a wire dropped into the void — "what to create here";
 * a variable dropped on a node — "where to connect it". That is why the menu
 * opens at the point of the event rather than in a corner of a panel, and the
 * very first character goes into the search: the hand does not leave the place
 * where the button was just released.
 *
 * The stage registry is long, so a list with a search is not decoration:
 * without it "create a node from here" would mean scrolling half a screen.
 * Enter takes the first match, the arrows walk the list, Esc closes it.
 *
 * The keyboard behaves as it does in a menu: the arrows SKIP separators,
 * headings and disabled items (otherwise the list stops at the first separator
 * and goes no further), and left/right move to the neighbouring section of the
 * menu bar. Focus is held by the menu root rather than by the first button: the
 * first item may be disabled, and the browser will not let such a button take
 * focus — so the keyboard would die before it started.
 */
import { paintIcon } from "./icons.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Menu {
  #items = [];
  #active = 0;
  #outside = null;

  /**
   * @param host   an element with `position: relative` (the canvas)
   * @param opts   {x, y} — the client coordinates of the event;
   *               title, hint — the header; search — show the search box;
   *               items — [{label, hint, shortcut, icon, iconMono, color,
   *                         keywords, checked, disabled, separator, heading,
   *                         apply}];
   *               closeOnOutside — close on a click outside (the menu bar);
   *               anchor — the button that opened the menu: a click on it does
   *               not count as "outside", otherwise the menu would close and
   *               open again on one press;
   *               onSide(±1) — move to the neighbouring section with the arrows
   */
  constructor(host, {
    x, y, title, hint, items, search = false, onClose,
    closeOnOutside = false, anchor = null, onSide = null,
  } = {}) {
    this.host = host;
    this.onClose = onClose;
    this.anchor = anchor;
    this.onSide = onSide;
    this.all = items ?? [];
    this.point = { x, y };

    this.root = el("div", "sf-menu");
    this.root.tabIndex = -1; // focus lives on the root: see the file header
    if (title) this.root.append(el("div", "sf-menu-title", title));
    if (hint) this.root.append(el("div", "sf-menu-hint", hint));

    if (search) {
      this.search = el("input", "sf-menu-search");
      this.search.type = "search";
      this.search.placeholder = "search…";
      this.search.oninput = () => this.#fill();
      this.root.append(this.search);
      this.root.classList.add("sf-menu-findable");
    }
    this.listEl = el("div", "sf-menu-list");
    this.root.append(this.listEl);

    this.root.addEventListener("keydown", (e) => this.#onKeyDown(e));
    host.append(this.root);
    this.#fill();
    this.#place();
    (this.search ?? this.root).focus?.();

    if (closeOnOutside) {
      this.#outside = (e) => {
        if (this.root.contains(e.target) || this.anchor?.contains(e.target)) return;
        this.close();
      };
      // capture: otherwise a click on the button of another menu would manage
      // to open that one first
      document.addEventListener("pointerdown", this.#outside, true);
    }
  }

  close() {
    if (this.#outside) document.removeEventListener("pointerdown", this.#outside, true);
    this.root.remove();
    this.onClose?.();
  }

  /**
   * Replace the items without closing the menu.
   *
   * The toolbar is redrawn on every change — and during a run the events come
   * in batches — so an open section would otherwise either slam shut under the
   * hand or show a state that no longer exists ("Step" disabled while the
   * session is already standing on a node). The position in the list is kept:
   * the cursor must not jump to the first item because a run ticked somewhere.
   */
  setItems(items) {
    const active = this.#active;
    this.all = items ?? [];
    this.#fill();
    if (active < this.#items.length && !this.#inert(this.#items[active])) {
      this.#setActive(active);
    }
    this.#place();
  }

  /** A redrawn toolbar means new buttons: the old anchor belongs to nobody. */
  setAnchor(anchor) { this.anchor = anchor; }

  /** Items you cannot stop on: decoration and disabled ones. */
  #inert(item) {
    return !item || item.separator || item.heading || item.disabled;
  }

  /** A match by label, hint and extra keywords (the category). */
  #match(item, query) {
    // separators and group headings disappear while searching: the groups are
    // no longer the same
    if (item.separator || item.heading) return !query;
    if (!query) return true;
    return `${item.label} ${item.hint ?? ""} ${item.keywords ?? ""}`
      .toLowerCase().includes(query);
  }

  #fill() {
    const query = (this.search?.value ?? "").trim().toLowerCase();
    this.#items = this.all.filter((item) => this.#match(item, query));
    this.#active = 0;
    this.listEl.textContent = "";

    if (!this.#items.length) {
      this.listEl.append(el("div", "sf-menu-empty", "nothing found"));
      return;
    }
    // the tick takes up room in EVERY item of a menu that has at least one
    // toggle: otherwise the labels would jump horizontally both when a tick is
    // switched on and simply when moving from group to group
    const withChecks = this.all.some((item) => item.checked !== undefined);

    this.#items.forEach((item, index) => {
      if (item.separator) {
        this.listEl.append(el("div", "sf-menu-sep"));
        return;
      }
      if (item.heading) {
        this.listEl.append(el("div", "sf-menu-head", item.heading));
        return;
      }
      const button = el("button", "sf-menu-item");
      if (item.color) button.style.setProperty("--kind-color", item.color);
      if (item.disabled) button.disabled = true;
      if (item.icon !== undefined) {
        button.append(paintIcon(el("span", "sf-icon"), item.icon,
          { mono: item.iconMono, fallback: item.fallback ?? "", base: item.iconBase }));
      }
      if (withChecks) {
        button.append(el("span", "sf-menu-check", item.checked ? "✓" : ""));
      }
      const text = el("span", "sf-menu-text");
      text.append(el("span", "sf-menu-label", item.label));
      if (item.hint) text.append(el("span", "sf-menu-sub", item.hint));
      button.append(text);
      if (item.shortcut) button.append(el("span", "sf-menu-key", item.shortcut));
      button.onclick = () => this.#pick(index);
      button.onpointerenter = () => this.#setActive(index);
      this.listEl.append(button);
    });
    this.#setActive(this.#items.findIndex((item) => !this.#inert(item)));
  }

  #setActive(index) {
    if (index < 0 || this.#inert(this.#items[index])) return;
    this.#active = index;
    [...this.listEl.children].forEach((child, i) => {
      child.classList?.toggle("sf-menu-active", i === index);
    });
  }

  /** The next item you can stand on: separators, headings and disabled entries
   * are stepped over, or the list would stop at the very first one. */
  #step(delta) {
    const count = this.#items.length;
    if (!count) return;
    let index = this.#active;
    for (let i = 0; i < count; i += 1) {
      index = (index + delta + count) % count;
      if (!this.#inert(this.#items[index])) break;
    }
    this.#setActive(index);
    this.listEl.children[this.#active]?.scrollIntoView({ block: "nearest" });
  }

  #pick(index) {
    const item = this.#items[index];
    if (this.#inert(item)) return;
    this.close();
    item.apply?.();
  }

  #onKeyDown(e) {
    const steps = { ArrowDown: 1, ArrowUp: -1 };
    const sides = { ArrowRight: 1, ArrowLeft: -1 };
    if (e.key in steps) {
      e.preventDefault();
      this.#step(steps[e.key]);
    } else if (this.onSide && e.key in sides) {
      // in a menu bar the neighbouring section is a step sideways, not a
      // "close and open"
      e.preventDefault();
      this.onSide(sides[e.key]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.#pick(this.#active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const anchor = this.anchor;
      this.close();
      // focus goes back to the section button: otherwise Esc would cut off
      // keyboard work and the mouse would have to be picked up again
      anchor?.focus?.();
    }
  }

  /** Puts the menu at the point of the event and tucks it inside the canvas if
   * it does not fit: a menu half off the edge cannot be chosen from. */
  #place() {
    const host = this.host.getBoundingClientRect();
    const size = this.root.getBoundingClientRect();
    const x = Math.max(6, Math.min(this.point.x - host.left + 4, host.width - size.width - 6));
    const y = Math.max(6, Math.min(this.point.y - host.top + 4, host.height - size.height - 6));
    this.root.style.left = `${x}px`;
    this.root.style.top = `${y}px`;
  }
}

export function openMenu(host, options) {
  return new Menu(host, options);
}
