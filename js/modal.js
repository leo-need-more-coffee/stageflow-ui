/**
 * The modal window of the editor: a shared frame for import/export, settings,
 * the stage registry and the run dialog.
 *
 * It lived in `toolbar.js` while the toolbar was the only thing opening
 * modals; the run dialog is opened from the editor facade, so the frame moved
 * into a module of its own — otherwise `rundialog.js` would drag the whole
 * button bar along with it.
 */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Modal {
  constructor(title) {
    this.overlay = el("div", "sf-modal-overlay");
    const box = el("div", "sf-modal");
    const head = el("div", "sf-modal-head");
    head.append(el("span", "sf-modal-title", title));
    const close = el("button", "sf-modal-close", "✕");
    close.onclick = () => this.close();
    head.append(close);
    this.body = el("div", "sf-modal-body");
    box.append(head, this.body);
    this.overlay.append(box);
    this.overlay.addEventListener("pointerdown", (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  open() {
    document.body.append(this.overlay);
    return this;
  }

  close() {
    this.overlay.remove();
  }
}
