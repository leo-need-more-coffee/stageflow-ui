/**
 * A popup menu: actions with search and keyboard control.
 *
 * Used by the canvas ("what to create here") and by the menu bar ("File",
 * "Edit", ...), so items support `shortcut`, `checked` (a tick for toggles),
 * `disabled`, separators and headings.
 *
 * On the canvas it opens where the gesture ended (a wire dropped on empty
 * space, a variable dropped on a node) and typing goes straight into the
 * search. Enter takes the first match, arrows move, Esc closes.
 *
 * Arrows skip separators, headings and disabled items; left/right move to the
 * neighbouring menu-bar section. Focus is on the menu root, because the first
 * item may be disabled and a disabled button cannot take focus.
 */
import { paintIcon } from "./icons.js";
import { t } from "./i18n.js";

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
   * @param opts   {x, y}: client coordinates of the event;
   *               title, hint: the header; search: show the search box;
   *               items: [{label, hint, shortcut, icon, iconMono, color,
   *                        keywords, checked, disabled, separator, heading,
   *                        apply}];
   *               closeOnOutside: close on a click outside (the menu bar);
   *               anchor: the button that opened it, which does not count as
   *               outside, or one press would close and reopen it;
   *               onSide(±1): move to the neighbouring section
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
      this.search.placeholder = t("common.search");
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
      // capture phase, so another menu's button does not open first
      document.addEventListener("pointerdown", this.#outside, true);
    }
  }

  close() {
    if (this.#outside) document.removeEventListener("pointerdown", this.#outside, true);
    this.root.remove();
    this.onClose?.();
  }

  /**
   * Replace the items without closing the menu. The toolbar is redrawn on
   * every change (often during a run), and an open section should neither
   * close nor show stale state. The position in the list is kept.
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

  /** After a toolbar redraw the old anchor button is gone. */
  setAnchor(anchor) { this.anchor = anchor; }

  /** Items that cannot be selected: decoration and disabled ones. */
  #inert(item) {
    return !item || item.separator || item.heading || item.disabled;
  }

  /** Match by label, hint and keywords (e.g. the category). */
  #match(item, query) {
    // separators and headings are hidden while searching
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
    // if any item is a toggle, every item reserves room for the tick, so
    // labels do not shift
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

  /** The next selectable item, skipping separators, headings and disabled ones. */
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
      // in the menu bar, sideways moves to the neighbouring section
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
      // return focus to the section button so the keyboard keeps working
      anchor?.focus?.();
    }
  }

  /** Place the menu at the event, moved inside the canvas if it would not fit. */
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
