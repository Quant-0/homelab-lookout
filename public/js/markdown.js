'use strict';
// Small, safe Markdown renderer: builds DOM nodes (never innerHTML), so documents can't
// inject markup or scripts. Links are limited to http(s), mailto and same-site paths.
// Supported: # headings, paragraphs, **bold**, *italic*, `code`, ``` blocks, [links](url),
// bare URLs, - / 1. lists (nested by indentation), - [ ] task lists, > quotes, --- rules, | tables |.

const MD = (() => {
  const { el } = HD;

  function safeHref(url) {
    try {
      const u = new URL(url, location.origin);
      if (['http:', 'https:', 'mailto:'].includes(u.protocol)) return u.href;
    } catch {
      /* invalid */
    }
    return null;
  }

  const INLINE = /(`+)([^`]+?)\1|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|__(.+?)__|\*([^*\s](?:[^*]*?[^*\s])?)\*|(?<![\w])_([^_\s](?:[^_]*?[^_\s])?)_(?![\w])|(https?:\/\/[^\s<>()]+[^\s<>().,:;!?"'])/g;

  function inline(text) {
    const out = [];
    let pos = 0;
    for (const m of text.matchAll(INLINE)) {
      if (m.index > pos) out.push(text.slice(pos, m.index));
      pos = m.index + m[0].length;
      if (m[2] !== undefined) out.push(el('code', { text: m[2] }));
      else if (m[3] !== undefined) {
        const href = safeHref(m[4]);
        out.push(href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, inline(m[3])) : m[0]);
      } else if (m[5] !== undefined || m[6] !== undefined) out.push(el('strong', null, inline(m[5] ?? m[6])));
      else if (m[7] !== undefined || m[8] !== undefined) out.push(el('em', null, inline(m[7] ?? m[8])));
      else if (m[9] !== undefined) {
        const href = safeHref(m[9]);
        out.push(href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: m[9] }) : m[9]);
      }
    }
    if (pos < text.length) out.push(text.slice(pos));
    return out;
  }

  const isFence = (l) => /^\s*```/.test(l);
  const isHeading = (l) => /^#{1,6}\s+/.test(l);
  const isRule = (l) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
  const isQuote = (l) => /^\s*>/.test(l);
  const listMatch = (l) => /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  function blocks(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      if (isFence(line)) {
        const code = [];
        i++;
        while (i < lines.length && !isFence(lines[i])) code.push(lines[i++]);
        i++;
        out.push(el('pre', null, el('code', { text: code.join('\n') })));
        continue;
      }
      if (isHeading(line)) {
        const [, hashes, text] = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        out.push(el(`h${Math.min(hashes.length + 1, 6)}`, null, inline(text)));
        i++;
        continue;
      }
      if (isRule(line)) {
        out.push(el('hr'));
        i++;
        continue;
      }
      if (isQuote(line)) {
        const inner = [];
        while (i < lines.length && isQuote(lines[i])) inner.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(el('blockquote', null, blocks(inner)));
        continue;
      }
      if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
        out.push(el('div', { class: 'table-wrap' }, el('table', null,
          el('thead', null, el('tr', null, head.map((c) => el('th', null, inline(c))))),
          el('tbody', null, rows.map((r) => el('tr', null, head.map((_, k) => el('td', null, inline(r[k] || '')))))))));
        continue;
      }
      const lm = listMatch(line);
      if (lm) {
        const indent = lm[1].length;
        const ordered = /\d/.test(lm[2]);
        const items = [];
        while (i < lines.length) {
          const m = listMatch(lines[i]);
          if (m && m[1].length === indent && /\d/.test(m[2]) === ordered) {
            items.push([m[3]]);
            i++;
          } else if (items.length && lines[i].trim() && (/^\s/.test(lines[i]) && (lines[i].match(/^\s*/)[0].length > indent))) {
            items[items.length - 1].push(lines[i].slice(Math.min(indent + 2, lines[i].match(/^\s*/)[0].length)));
            i++;
          } else break;
        }
        out.push(el(ordered ? 'ol' : 'ul', null, items.map(([first, ...rest]) => {
          const task = /^\[([ xX])\]\s+(.*)$/.exec(first);
          const head = task
            ? [el('input', { type: 'checkbox', disabled: true, checked: task[1] !== ' ' }), ' ', ...inline(task[2])]
            : inline(first);
          return el('li', { class: task ? 'task' : null }, head, rest.length ? blocks(rest) : null);
        })));
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !isFence(lines[i]) && !isHeading(lines[i]) && !isQuote(lines[i]) && !listMatch(lines[i]) && !isRule(lines[i]) && !(isTableRow(lines[i]) && isTableSep(lines[i + 1] || ''))) {
        para.push(lines[i++].trim());
      }
      out.push(el('p', null, para.flatMap((t, k) => (k ? [el('br'), ...inline(t)] : inline(t)))));
    }
    return out;
  }

  function render(src) {
    return el('div', { class: 'md' }, blocks(String(src || '').replace(/\r\n?/g, '\n').split('\n')));
  }

  return { render, inline };
})();
