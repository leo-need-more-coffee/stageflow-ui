/**
 * The editor's modal window: the frame used by import/export, settings, the
 * stage registry and the run dialog.
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
