'use strict';
// Claude on Home and the wall display: the tile, its details drawer, and the wall panel in four
// styles (a big number, limit rings, a full tile, a ticker line). The numbers come with
// /api/dashboard as `claude` (null when nothing is set up in Admin → Dashboard → Claude); which
// of them show is chosen by the owner with Customize. Costs for Claude Code are estimates at API
// list prices; a subscription is billed differently.

const Claude = (() => {
  const { el, svg, fmt } = HD;
  const STAT_NAMES = { tokens: 'Tokens', cost: 'Cost', sessions: 'Sessions and active time', models: 'Models and cache hits', limits: 'Plan limits', status: 'Claude status' };
  const STYLE_NAMES = { number: 'Big number', rings: 'Limit rings', tile: 'Full tile', ticker: 'Ticker line' };
  const STATUS_CLS = { none: 'good', minor: 'warning', major: 'critical', critical: 'critical', maintenance: 'warning' };
  const PLANS = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free' };

  // 13 169 926 -> "13.2M"
  function tok(v) {
    if (v == null) return '–';
    const a = Math.abs(v);
    if (a < 1000) return fmt.n(v);
    const [d, u] = a < 1e6 ? [1e3, 'k'] : a < 1e9 ? [1e6, 'M'] : [1e9, 'B'];
    return `${fmt.n(v / d, v / d < 100 ? 1 : 0)}${u}`;
  }
  const usd = (v, d) => (v == null ? '–' : `$${fmt.n(v, d ?? (Math.abs(v) < 100 ? 2 : 0))}`);
  const minutes = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
  const pctCls = (p) => (p >= 90 ? 'critical' : p >= 70 ? 'warning' : 'good');
  const dayName = (date, long) => new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', long ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'narrow' });
  // "in 3 h 40 min" or "Fri 11:00"
  function resetText(ms) {
    if (!ms) return '';
    const m = Math.round((ms - Date.now()) / 60000);
    if (m <= 0) return 'resets now';
    if (m < 24 * 60) return `resets in ${minutes(m)}`;
    return `resets ${new Date(ms).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
  }
  const has = (c, key) => {
    if (key === 'tokens' || key === 'cost' || key === 'sessions' || key === 'models') return c.reporters > 0 || (key !== 'sessions' && Boolean(c.api));
    if (key === 'limits') return Boolean(c.limits && (c.limits.fiveHour || c.limits.sevenDay || c.limits.error));
    if (key === 'status') return Boolean(c.status);
    return false;
  };
  const shown = (c, stats) => stats.filter((k) => has(c, k));
  const statusOk = (s) => s && !s.error && s.indicator;
  function statusChip(s) {
    if (!s) return null;
    if (!statusOk(s)) return el('span', { class: 'cl-status muted' }, el('span', { class: 'dot off' }), s.error ? 'Status unknown' : 'Checking status…');
    return el('span', { class: `cl-status ${STATUS_CLS[s.indicator] || ''}` }, el('span', { class: `dot ${STATUS_CLS[s.indicator] || 'off'}` }), s.text);
  }

  // The headline: Claude Code today, else the API, else the plan limits, else the status
  function headline(c, stats) {
    const code = c.reporters > 0;
    // fact: the wall's label for the same number, left out of the numbers under it
    if (stats.includes('tokens') && (code || c.api)) return { value: tok(code ? c.today.tokens : c.api.today.tokens), unit: code ? 'tokens today' : 'API tokens today', fact: 'Tokens today' };
    if (stats.includes('cost') && (code || c.api)) return code ? { value: usd(c.today.cost), unit: 'today at API prices', fact: 'Today' } : { value: usd(c.api.month), unit: 'API this month', fact: 'API month' };
    if (stats.includes('limits') && c.limits?.fiveHour) return { value: `${fmt.n(c.limits.fiveHour.pct)}`, unit: '% of the 5-hour limit', fact: '5 hours' };
    if (stats.includes('status') && statusOk(c.status)) return { value: c.status.indicator === 'none' ? 'OK' : c.status.indicator === 'minor' ? 'Minor' : 'Outage', unit: c.status.text, cls: STATUS_CLS[c.status.indicator] };
    return { value: '–', unit: code ? 'no use yet' : 'nothing to show yet' };
  }

  // The smaller numbers under the headline, for the stats chosen
  function facts(c, stats) {
    const out = [];
    const code = c.reporters > 0;
    if (stats.includes('tokens') && code) out.push([tok(c.week.tokens), 'tokens, 7 days']);
    if (stats.includes('cost')) {
      if (code) out.push([usd(c.today.cost), 'today'], [usd(c.week.cost), '7 days']);
      if (c.api) out.push([usd(c.api.month), 'API this month']);
    }
    if (stats.includes('sessions') && code) out.push([fmt.n(c.today.sessions), c.today.sessions === 1 ? 'session today' : 'sessions today'], [minutes(c.today.active), 'active today']);
    if (stats.includes('models')) {
      const top = (code ? c.models.week : c.api?.models || [])[0];
      if (top) out.push([top.name, 'most used, 7 days']);
      if (code && c.week.cacheHit != null) out.push([`${fmt.n(c.week.cacheHit * 100)} %`, 'cache hits']);
    }
    return out;
  }

  // Bars for the last days (tokens), the newest on the right
  function bars(days, n, key = 'tokens', cls = '') {
    const list = days.slice(-n);
    const max = Math.max(1, ...list.map((d) => d[key]));
    return el('div', { class: `cl-bars ${cls}`, role: 'img', 'aria-label': `${key === 'cost' ? 'Cost' : 'Tokens'} per day, the last ${n} days` },
      list.map((d, i) => {
        const b = el('span', { title: `${dayName(d.date, true)}: ${key === 'cost' ? usd(d[key]) : `${tok(d[key])} tokens`}` }, el('i'), n <= 14 ? el('small', { text: dayName(d.date) }) : null);
        b.style.setProperty('--h', `${Math.max(d[key] ? 4 : 0, (100 * d[key]) / max).toFixed(1)}%`);
        if (i === list.length - 1) b.classList.add('now');
        return b;
      }));
  }

  function meter(label, w) {
    if (!w) return null;
    const bar = el('i');
    bar.style.setProperty('--w', `${Math.min(100, w.pct).toFixed(1)}%`);
    return el('div', { class: `cl-meter ${pctCls(w.pct)}` },
      el('span', { class: 'l', text: label }), el('span', { class: 'bar' }, bar),
      el('strong', { class: 'num', text: `${fmt.n(w.pct)} %` }),
      el('span', { class: 'when', text: resetText(w.resetsAt) }));
  }
  function limitRows(l) {
    if (!l) return [];
    return [meter('5 hours', l.fiveHour), meter('Week', l.sevenDay), meter('Week, Opus', l.sevenDayOpus), meter('Week, Sonnet', l.sevenDaySonnet)].filter(Boolean);
  }

  function ring(label, w) {
    const r = 42;
    const len = 2 * Math.PI * r;
    const arc = svg('circle', { class: 'arc', cx: 50, cy: 50, r, 'stroke-dasharray': `${((Math.min(100, w.pct) / 100) * len).toFixed(1)} ${len.toFixed(1)}` });
    return el('div', { class: `cl-ring ${pctCls(w.pct)}` },
      svg('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' }, svg('circle', { class: 'track', cx: 50, cy: 50, r }), arc),
      el('div', { class: 'in' }, el('b', { class: 'num' }, fmt.n(w.pct), el('small', { text: '%' })), el('span', { text: label })),
      el('span', { class: 'when', text: resetText(w.resetsAt) }));
  }

  // --- Home: the tile ---
  // edit: { stats, hidden, onChange(stats, hidden) } while Customize is open
  function homeTile(c, onOpen, edit = null) {
    const stats = edit ? edit.stats : c.home.stats;
    const h = headline(c, stats);
    const l = stats.includes('limits') ? c.limits : null;
    const b = el(edit ? 'div' : 'button', { type: edit ? null : 'button', class: `big claude-tile${edit?.hidden ? ' tile-off' : ''}`, 'aria-label': edit ? null : 'Claude usage' },
      el('span', { class: 'big-head' }, HD.icon('sparkles'), 'Claude',
        stats.includes('status') ? statusChip(c.status) : null,
        edit ? null : el('span', { class: 'go' }, 'Details', HD.icon('arrow-right'))),
      el('span', { class: 'cl-body' },
        el('span', { class: 'cl-main' },
          el('span', { class: `big-num${h.cls ? ` ${h.cls}` : ''}` }, h.value, el('small', { text: h.unit })),
          el('span', { class: 'big-facts' }, facts(c, stats).map(([v, t]) => el('span', null, el('strong', { text: v }), ` ${t}`)))),
        stats.includes('tokens') && c.reporters > 0 ? bars(c.days, 7) : null,
        l ? el('span', { class: 'cl-limits' },
          el('span', { class: 'cl-sub', text: [l.plan ? `${PLANS[l.plan] || l.plan} plan` : 'Plan', 'limits'].join(' ') }),
          limitRows(l), l.error ? el('span', { class: 'small muted', text: l.error }) : null) : null),
      edit ? editBox(edit) : null);
    if (!edit) b.addEventListener('click', onOpen);
    return b;
  }

  // Customize on Home: what the tile shows
  function editBox(edit) {
    const on = (key, cb) => {
      edit.stats = cb.checked ? Object.keys(STAT_NAMES).filter((k) => k === key || edit.stats.includes(k)) : edit.stats.filter((k) => k !== key);
      edit.onChange();
    };
    const show = el('input', { type: 'checkbox', checked: !edit.hidden, 'aria-label': 'Show the Claude tile on Home' });
    show.addEventListener('change', () => {
      edit.hidden = !show.checked;
      edit.onChange();
    });
    return el('fieldset', { class: 'cl-edit' },
      el('legend', { class: 'small muted', text: 'This tile shows' }),
      el('label', { class: 'check' }, show, ' On Home'),
      Object.entries(STAT_NAMES).map(([k, t]) => {
        const cb = el('input', { type: 'checkbox', name: `claude-${k}`, checked: edit.stats.includes(k), disabled: edit.hidden });
        cb.addEventListener('change', () => on(k, cb));
        return el('label', { class: 'check' }, cb, ` ${t}`);
      }));
  }

  // --- the details drawer ---
  function detail(c, loggedIn) {
    const tile = (label, v, unit, sub) => el('div', { class: 'ptile' }, el('span', { class: 'l', text: label }), el('span', { class: 'v num' }, v, unit ? el('small', { text: ` ${unit}` }) : null), sub ? el('span', { class: 'sub', text: sub }) : null);
    const s = c.status;
    const code = c.reporters > 0;
    const l = c.limits;
    const table = (head, rows) => el('div', { class: 'table-wrap' }, el('table', { class: 'cl-table' },
      el('thead', null, el('tr', null, head.map((t, i) => el('th', { class: i ? 'r' : null, text: t })))),
      el('tbody', null, rows.map((r) => el('tr', null, r.map((v, i) => el('td', { class: i ? 'r num' : null }, v)))))));
    return el('article', { class: 'detail claude-card' },
      el('header', { class: 'd-head' },
        el('span', { class: 'tile-icon' }, HD.icon('sparkles')),
        el('div', { class: 't' }, el('h2', { text: 'Claude' }), el('p', { text: [code ? `Claude Code on ${c.machines.length} machine${c.machines.length === 1 ? '' : 's'}` : null, c.api ? 'API organization' : null, s ? 'status page' : null].filter(Boolean).join(' · ') })),
        statusChip(s)),
      s?.incidents?.length ? s.incidents.map((x) => el('div', { class: `callout ${x.impact === 'critical' || x.impact === 'major' ? 'critical' : 'warning'}` },
        el('b', { text: x.name }), el('span', { class: 'small' }, `${x.status}${x.updatedAt ? ` · ${fmt.time(x.updatedAt)}` : ''} `, x.link ? el('a', { href: x.link, target: '_blank', rel: 'noopener noreferrer', text: 'More on status.claude.com' }) : null))) : null,
      l ? el('section', { class: 'cl-sec' },
        el('h4', { text: `${l.plan ? `${PLANS[l.plan] || l.plan} plan` : 'Plan'} limits` }),
        el('div', { class: 'cl-limits' }, limitRows(l)),
        el('p', { class: 'small muted', text: [l.error, `From ${l.machine}, ${fmt.ago(l.at)}`, 'Read from Anthropic with that machine’s own sign-in (an unofficial source that may change).'].filter(Boolean).join(' · ') })) : null,
      code ? el('section', { class: 'cl-sec' },
        el('h4', { text: 'Claude Code' }),
        el('div', { class: 'power-tiles' },
          tile('Today', tok(c.today.tokens), 'tokens', `${usd(c.today.cost)} · ${fmt.n(c.today.replies)} replies`),
          tile('7 days', tok(c.week.tokens), 'tokens', usd(c.week.cost)),
          tile('This month', tok(c.month.tokens), 'tokens', usd(c.month.cost)),
          tile('Sessions today', fmt.n(c.today.sessions), null, `${minutes(c.today.active)} active`)),
        el('div', { class: 'power-chart' }, el('div', { class: 'chart-title', text: 'Tokens per day, last 30 days' }), bars(c.days, 30, 'tokens', 'wide')),
        el('div', { class: 'kv' },
          ...[['Output today', `${tok(c.today.output)} tokens`], ['Cache reads today', `${tok(c.today.cacheRead)} tokens`], ['Cache writes today', `${tok(c.today.cacheWrite)} tokens`], ['Cache hits, 7 days', c.week.cacheHit != null ? `${fmt.n(c.week.cacheHit * 100, 1)} %` : '–']]
            .map(([k, v]) => el('div', null, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v })))),
        c.models.week.length ? [el('h4', { text: 'Models, 7 days' }), table(['Model', 'Tokens', 'Share', 'Cache hits', 'Cost'], c.models.week.map((m) => [m.name, tok(m.tokens), `${fmt.n((100 * m.tokens) / (c.week.tokens || 1))} %`, m.cacheHit != null ? `${fmt.n(m.cacheHit * 100)} %` : '–', m.unpriced ? '–' : usd(m.cost)]))] : null,
        el('h4', { text: 'Machines' }),
        table(['Machine', 'Today', '7 days', 'Last report'], c.machines.map((x) => [
          el('span', null, el('span', { class: `led ${x.removedAt ? 'off' : x.ok ? 'good' : x.never ? 'off' : 'critical'}` }), ' ', el('strong', { text: x.name }), x.host && x.host !== x.name ? el('span', { class: 'small muted', text: ` ${x.host}` }) : null,
            x.version && x.latest && x.version !== x.latest ? el('div', { class: 'small warning-text', text: `Reporter ${x.latest} available` }) : null),
          tok(x.today.tokens), tok(x.week.tokens), x.removedAt ? 'uninstalled' : x.at ? fmt.ago(x.at) : 'never yet'])),
        el('p', { class: 'hint', text: 'Counted from Claude Code’s own logs on each machine. Costs are estimates at API list prices; a Pro or Max plan is billed by subscription.' })) : null,
      c.api ? el('section', { class: 'cl-sec' },
        el('h4', { text: 'API organization (Usage and Cost API)' }),
        c.api.error ? el('div', { class: 'callout warning' }, el('b', { text: 'Could not read the latest numbers' }), el('span', { class: 'small', text: c.api.error })) : null,
        el('div', { class: 'power-tiles' },
          tile('Today (UTC)', usd(c.api.today.cost), null, `${tok(c.api.today.tokens)} tokens`),
          tile('7 days', usd(c.api.week.cost), null, `${tok(c.api.week.tokens)} tokens`),
          tile('This month', usd(c.api.month), null, 'billed, before credits')),
        el('div', { class: 'power-chart' }, el('div', { class: 'chart-title', text: 'Cost per day, last 30 days' }), bars(c.api.days, 30, 'cost', 'wide')),
        c.api.models.length ? table(['Model, 7 days', 'Tokens', 'Cost'], c.api.models.map((m) => [m.name, tok(m.tokens), usd(m.cost)])) : null,
        el('p', { class: 'hint', text: `Anthropic updates these within hours.${c.api.refreshedAt ? ` Complete up to ${fmt.time(c.api.refreshedAt)}.` : ''}` })) : null,
      s ? el('section', { class: 'cl-sec' },
        el('h4', { text: 'Status' }),
        s.error ? el('p', { class: 'small muted', text: `The status page did not answer: ${s.error}` }) : null,
        el('ul', { class: 'cl-components' }, (s.components || []).map((x) => el('li', null, el('span', { class: `dot ${x.status === 'operational' ? 'good' : x.status === 'major_outage' ? 'critical' : x.status === 'under_maintenance' ? 'off' : 'warning'}` }), el('span', { text: x.name }), el('span', { class: 'small muted', text: x.status.replace(/_/g, ' ') })))),
        el('p', { class: 'small muted' }, s.at ? `Checked ${fmt.ago(s.at)} · ` : '', el('a', { href: 'https://status.claude.com', target: '_blank', rel: 'noopener noreferrer', text: 'status.claude.com' }))) : null,
      loggedIn ? el('div', { class: 'detail-actions' }, el('a', { class: 'button ghost', href: '/admin#claude' }, HD.icon('pencil'), 'Edit in Admin')) : null);
  }

  // --- the wall display ---
  // The numbers for a trio, from the stats chosen (the first one is the big number)
  function wallFacts(c, stats) {
    const out = [];
    const code = c.reporters > 0;
    for (const k of stats) {
      if (k === 'tokens' && (code || c.api)) out.push(['Tokens today', tok(code ? c.today.tokens : c.api.today.tokens)], ['7 days', tok(code ? c.week.tokens : c.api.week.tokens)]);
      if (k === 'cost' && (code || c.api)) out.push(code ? ['Today', usd(c.today.cost)] : ['API month', usd(c.api.month)]);
      if (k === 'sessions' && code) out.push(['Active today', minutes(c.today.active)]);
      if (k === 'models' && code && c.week.cacheHit != null) out.push(['Cache hits', `${fmt.n(c.week.cacheHit * 100)} %`]);
      if (k === 'limits' && c.limits?.fiveHour) out.push(['5 hours', `${fmt.n(c.limits.fiveHour.pct)} %`, 'lim']);
      if (k === 'limits' && c.limits?.sevenDay) out.push(['Week', `${fmt.n(c.limits.sevenDay.pct)} %`, 'lim']);
    }
    return out;
  }
  const trio = (items, cls = '') => el('div', { class: `trio cl-trio ${cls}` }, items.slice(0, 3).map(([label, v]) => el('div', null, el('span', { text: label }), el('b', { text: v }))));

  function wallPanel(box, c, cfg) {
    const stats = shown(c, cfg.stats);
    const lbl = el('div', { class: 'lbl' }, HD.icon('sparkles'), 'Claude', el('span', { class: 'r' }, stats.includes('status') ? statusChip(c.status) : null));
    box.onclick = () => (location.href = '/#claude');
    const l = c.limits;
    if (cfg.style === 'rings' && l && (l.fiveHour || l.sevenDay)) {
      box.replaceChildren(lbl, el('div', { class: 'cl-rings' }, [l.fiveHour ? ring('5 hours', l.fiveHour) : null, l.sevenDay ? ring('week', l.sevenDay) : null].filter(Boolean)),
        trio(wallFacts(c, stats.filter((k) => k !== 'limits'))));
      return;
    }
    const h = headline(c, stats);
    const meters = cfg.style === 'tile' && stats.includes('limits') && l;
    const rest = wallFacts(c, stats);
    box.replaceChildren(...[lbl, // replaceChildren would turn null into the text "null"
      el('div', { class: `huge${h.cls ? ` ${h.cls}` : ''}` }, h.value, el('small', { text: h.unit })),
      cfg.style === 'tile' && c.reporters > 0 ? el('div', { class: 'wall-chart cl-wall-bars' }, bars(c.days, 7)) : el('div', { class: 'wall-chart' }),
      meters ? el('div', { class: 'cl-limits' }, limitRows(l)) : null,
      // with the limit bars, the numbers under them leave the limits out; a short panel hides the
      // bars (CSS) and shows the other row, limits included
      ...(meters ? [trio(rest.filter(([label, , kind]) => label !== h.fact && kind !== 'lim'), 'cl-tall'), trio(rest.filter(([label]) => label !== h.fact), 'cl-short')] : [trio(rest.filter(([label]) => label !== h.fact))])].filter(Boolean));
  }

  function ticker(box, c, cfg) {
    const stats = shown(c, cfg.stats);
    const s = c.status;
    const items = wallFacts(c, stats);
    box.onclick = () => (location.href = '/#claude');
    box.replaceChildren(...[el('span', { class: 'cl-tick-name' }, HD.icon('sparkles'), 'Claude'),
      stats.includes('status') && s ? statusChip(s) : null,
      ...items.map(([label, v]) => el('span', { class: 'cl-tick' }, el('b', { text: v }), ` ${label.toLowerCase()}`))].filter(Boolean));
  }

  return { STAT_NAMES, STYLE_NAMES, homeTile, detail, wallPanel, ticker, tok };
})();
