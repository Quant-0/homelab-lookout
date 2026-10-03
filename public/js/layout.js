'use strict';
// Widget board: a 12-column grid with vertical "gravity" (widgets float up), drag to move,
// corner handle to resize, keyboard control, and auto-height for widgets without a saved size.

const GridLayout = (() => {
  const { el } = HD;
  const COLS = 12;
  const MIN_W = 2;
  const MIN_H = 2;

  const overlaps = (a, b) => a !== b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  // Place every item as high as possible, top-to-bottom, around an optional pinned item.
  function compact(items, pinned = null) {
    const placed = pinned ? [pinned] : [];
    const rest = items.filter((i) => i !== pinned).sort((a, b) => a.y - b.y || a.x - b.x);
    for (const it of rest) {
      it.y = 0;
      while (placed.some((p) => overlaps(p, it))) it.y++;
      placed.push(it);
    }
  }

  function firstFit(items, w, h) {
    for (let y = 0; ; y++) {
      for (let x = 0; x + w <= COLS; x++) {
        const probe = { x, y, w, h };
        if (!items.some((i) => overlaps(i, probe))) return { x, y };
      }
    }
  }

  class Board {
    constructor(grid, { onEditChange } = {}) {
      this.grid = grid;
      this.onEditChange = onEditChange || (() => {});
      this.items = new Map(); // id -> { id, x, y, w, h, auto }
      this.hidden = new Set();
      this.widgets = new Map(); // id -> { el, body, label }
      this.defs = [];
      this.editing = false;
      this.drag = null;
      this.pendingDefs = null;
      this.mobile = window.matchMedia('(max-width: 720px)');
    }

    load(layout) {
      this.items.clear();
      this.hidden = new Set(layout?.hidden || []);
      // layouts saved before the compact cards keep their places; their heights are measured again
      const fresh = layout?.v === 2;
      for (const i of layout?.items || []) this.items.set(i.id, { ...i, auto: !fresh });
    }

    snapshot() {
      return {
        v: 2,
        items: [...this.items.values()].map(({ id, x, y, w, h, saved }) => ({ id, x, y, w, h: saved ?? h })),
        hidden: [...this.hidden].filter((id) => this.defs.some((d) => d.id === id)),
      };
    }

    // defs: [{ id, title, w, h, node }] in default order
    render(defs) {
      this.defs = defs;
      if (this.drag) {
        this.pendingDefs = defs; // don't swap content under the pointer
        return;
      }
      const ids = new Set(defs.map((d) => d.id));
      for (const id of [...this.items.keys()]) if (!ids.has(id)) this.items.delete(id);
      for (const d of defs) {
        if (this.items.has(d.id) || this.hidden.has(d.id)) continue;
        const w = Math.min(COLS, d.w);
        this.items.set(d.id, { id: d.id, ...firstFit([...this.items.values()], w, d.h), w, h: d.h, auto: true });
      }
      for (const d of defs) {
        if (this.hidden.has(d.id)) continue;
        const wg = this.widget(d.id);
        wg.label.textContent = d.title;
        wg.chrome.setAttribute('aria-label', `${d.title}: arrow keys move, Shift + arrow keys resize`);
        wg.body.replaceChildren(d.node);
      }
      for (const [id, wg] of this.widgets) {
        if (!this.items.has(id)) {
          wg.el.remove();
          this.widgets.delete(id);
        }
      }
      this.apply();
      this.measure([...this.items.values()].filter((i) => i.auto || i.saved != null));
    }

    // Content changed size after rendering (e.g. graphs arrived): measure the auto-sized widgets again
    remeasure() {
      if (!this.editing && !this.drag) this.measure([...this.items.values()].filter((i) => i.auto || i.saved != null));
    }

    // A widget whose details are open grows to its content; closing gives back its own size
    grow(id) {
      const it = this.items.get(id);
      if (!it || this.mobile.matches) return;
      if (!it.auto && it.saved == null) it.saved = it.h;
      this.measure([it]);
    }

    shrink(id) {
      const it = this.items.get(id);
      if (!it || this.mobile.matches) return;
      if (it.saved != null) {
        it.h = it.saved;
        delete it.saved;
        compact([...this.items.values()]);
        this.apply();
      } else if (it.auto) this.measure([it]);
    }

    widget(id) {
      let wg = this.widgets.get(id);
      if (wg) return wg;
      const body = el('div', { class: 'widget-body' });
      const label = el('span', { class: 'widget-label' });
      const chrome = el('div', { class: 'widget-chrome', tabindex: '0', role: 'group' },
        label,
        el('div', { class: 'widget-bar' },
          el('button', { type: 'button', text: 'Fit height', title: 'Resize to fit the content', onclick: () => this.fit(id) }),
          el('button', { type: 'button', text: 'Hide', onclick: () => this.hide(id) })),
        el('div', { class: 'resize-handle', title: 'Drag to resize' }));
      chrome.addEventListener('pointerdown', (e) => this.pointerDown(id, e));
      chrome.addEventListener('keydown', (e) => this.key(id, e));
      wg = { el: el('div', { class: 'widget', 'data-id': id }, body, chrome), body, chrome, label };
      this.widgets.set(id, wg);
      this.grid.append(wg.el);
      return wg;
    }

    apply() {
      const sorted = [...this.items.values()].sort((a, b) => a.y - b.y || a.x - b.x);
      sorted.forEach((it, rank) => {
        const wg = this.widgets.get(it.id);
        if (!wg) return;
        wg.el.style.order = String(rank); // used by the single-column phone layout
        const target = this.drag && this.drag.id === it.id ? this.drag.placeholder : wg.el;
        target.style.gridColumn = `${it.x + 1} / span ${it.w}`;
        target.style.gridRow = `${it.y + 1} / span ${it.h}`;
      });
    }

    metrics() {
      const cs = getComputedStyle(this.grid);
      const gap = parseFloat(cs.columnGap) || 16;
      const rowH = parseFloat(cs.gridAutoRows) || 24;
      const colW = (this.grid.clientWidth - gap * (COLS - 1)) / COLS;
      return { gap, rowH, colStep: colW + gap, rowStep: rowH + gap };
    }

    // Set h to the natural content height for the given items.
    measure(list) {
      if (!list.length || this.mobile.matches) return;
      const { gap, rowH } = this.metrics();
      for (const it of list) {
        const wg = this.widgets.get(it.id);
        if (!wg) continue;
        wg.el.classList.add('measuring');
        wg.el.style.gridRow = `${it.y + 1} / span 1`;
      }
      let changed = false;
      for (const it of list) {
        const wg = this.widgets.get(it.id);
        if (!wg) continue;
        const h = Math.max(MIN_H, Math.ceil((wg.el.offsetHeight + gap) / (rowH + gap)));
        wg.el.classList.remove('measuring');
        if (h !== it.h) {
          it.h = h;
          changed = true;
        }
      }
      if (changed) compact([...this.items.values()]);
      this.apply();
    }

    fit(id) {
      const it = this.items.get(id);
      if (!it) return;
      this.measure([it]);
      it.auto = false;
    }

    hide(id) {
      this.items.delete(id);
      this.hidden.add(id);
      const wg = this.widgets.get(id);
      if (wg) {
        wg.el.remove();
        this.widgets.delete(id);
      }
      compact([...this.items.values()]);
      this.apply();
      this.onEditChange();
    }

    show(id) {
      this.hidden.delete(id);
      this.render(this.defs);
      this.onEditChange();
    }

    hiddenWidgets() {
      return this.defs.filter((d) => this.hidden.has(d.id));
    }

    reset() {
      this.items.clear();
      this.hidden.clear();
      this.render(this.defs);
      for (const it of this.items.values()) it.auto = false;
      this.onEditChange();
    }

    startEdit() {
      this.before = this.snapshot();
      for (const it of this.items.values()) {
        if (it.saved != null) {
          it.h = it.saved; // edit the widget's own size, not the opened-up one
          delete it.saved;
        }
        it.auto = false;
      }
      this.editing = true;
      document.body.classList.add('editing');
      this.onEditChange();
    }

    stopEdit(revert) {
      if (revert && this.before) this.load(this.before);
      this.editing = false;
      document.body.classList.remove('editing');
      this.render(this.defs);
      this.onEditChange();
    }

    pointerDown(id, e) {
      if (!this.editing || e.button !== 0 || e.target.closest('button')) return;
      const wg = this.widgets.get(id);
      const it = this.items.get(id);
      const mode = e.target.classList.contains('resize-handle') ? 'resize' : 'move';
      const g = this.grid.getBoundingClientRect();
      const r = wg.el.getBoundingClientRect();
      const placeholder = el('div', { class: 'widget-placeholder' });
      this.grid.append(placeholder);
      this.drag = { id, mode, it, start: { ...it }, px: e.clientX, py: e.clientY, rect: r, m: this.metrics(), placeholder };
      Object.assign(wg.el.style, {
        gridColumn: '',
        gridRow: '',
        left: `${r.left - g.left}px`,
        top: `${r.top - g.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      wg.el.classList.add('dragging');
      this.apply();
      wg.chrome.setPointerCapture(e.pointerId);
      const move = (ev) => this.pointerMove(ev);
      const up = () => {
        wg.chrome.removeEventListener('pointermove', move);
        wg.chrome.removeEventListener('pointerup', up);
        wg.chrome.removeEventListener('pointercancel', up);
        this.pointerUp();
      };
      wg.chrome.addEventListener('pointermove', move);
      wg.chrome.addEventListener('pointerup', up);
      wg.chrome.addEventListener('pointercancel', up);
      e.preventDefault();
    }

    pointerMove(e) {
      const d = this.drag;
      if (!d) return;
      const wg = this.widgets.get(d.id);
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      const { colStep, rowStep } = d.m;
      let next;
      if (d.mode === 'move') {
        wg.el.style.transform = `translate(${dx}px, ${dy}px)`;
        next = {
          x: Math.min(Math.max(Math.round(d.start.x + dx / colStep), 0), COLS - d.it.w),
          y: Math.max(Math.round(d.start.y + dy / rowStep), 0),
        };
      } else {
        wg.el.style.width = `${Math.max(d.rect.width + dx, colStep * MIN_W)}px`;
        wg.el.style.height = `${Math.max(d.rect.height + dy, rowStep * MIN_H)}px`;
        next = {
          w: Math.min(Math.max(Math.round(d.start.w + dx / colStep), MIN_W), COLS - d.it.x),
          h: Math.max(Math.round(d.start.h + dy / rowStep), MIN_H),
        };
      }
      if (Object.entries(next).some(([k, v]) => d.it[k] !== v)) {
        Object.assign(d.it, next);
        compact([...this.items.values()], d.it);
        this.apply();
      }
    }

    pointerUp() {
      const d = this.drag;
      if (!d) return;
      const wg = this.widgets.get(d.id);
      d.placeholder.remove();
      wg.el.classList.remove('dragging');
      Object.assign(wg.el.style, { left: '', top: '', width: '', height: '', transform: '' });
      this.drag = null;
      compact([...this.items.values()]);
      this.apply();
      this.onEditChange();
      if (this.pendingDefs) {
        const defs = this.pendingDefs;
        this.pendingDefs = null;
        this.render(defs);
      }
    }

    // Arrow keys move, Shift + arrows resize. Up/Down jump past the neighbouring widget.
    key(id, e) {
      if (!this.editing) return;
      const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const dir = dirs[e.key];
      if (!dir) return;
      e.preventDefault();
      const it = this.items.get(id);
      const all = [...this.items.values()];
      if (e.shiftKey) {
        it.w = Math.min(Math.max(it.w + dir[0], MIN_W), COLS - it.x);
        it.h = Math.max(it.h + dir[1], MIN_H);
      } else if (dir[0]) {
        it.x = Math.min(Math.max(it.x + dir[0], 0), COLS - it.w);
      } else {
        const column = all.filter((o) => o !== it && o.x < it.x + it.w && it.x < o.x + o.w);
        if (dir[1] > 0) {
          const below = column.filter((o) => o.y >= it.y + it.h).sort((a, b) => a.y - b.y)[0];
          if (below) it.y = below.y + 1;
        } else {
          const above = column.filter((o) => o.y + o.h <= it.y).sort((a, b) => b.y - a.y)[0];
          if (above) it.y = above.y;
        }
      }
      compact(all, it);
      compact(all);
      this.apply();
      this.onEditChange();
      this.widgets.get(id).chrome.focus();
    }
  }

  return { Board, COLS, compact, firstFit };
})();
