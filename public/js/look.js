'use strict';
// The look of this device: a theme and an accent the viewer picked, over the owner's default
// (which the server puts on <html>). Loaded in <head> so the page never flashes the other look.
// Stored in this browser only; HD.openLook() changes it.

const HD_LOOK = (() => {
  const THEMES = {
    auto: 'Auto', dark: 'Dark', light: 'Light', nord: 'Nord', dracula: 'Dracula', 'catppuccin-mocha': 'Catppuccin Mocha', 'catppuccin-latte': 'Catppuccin Latte',
    'solarized-dark': 'Solarized Dark', 'solarized-light': 'Solarized Light', 'gruvbox-dark': 'Gruvbox Dark', 'tokyo-night': 'Tokyo Night',
    graphite: 'Graphite', oled: 'OLED Black', ocean: 'Deep Ocean', forest: 'Forest', ember: 'Ember', 'rose-pine': 'Rosé Pine', synthwave: 'Synthwave', arctic: 'Arctic', sandstone: 'Sandstone', 'high-contrast': 'High Contrast',
  };
  // name -> [colour on light grounds, colour on dark grounds]; "theme" keeps the theme's own
  const ACCENTS = {
    theme: null, indigo: ['#5e6ad2', '#7b7bff'], blue: ['#2563eb', '#4f8dff'], teal: ['#0f8f84', '#2ec4b6'], green: ['#16a34a', '#34c46a'],
    amber: ['#b26b00', '#f5a524'], pink: ['#d02a7f', '#f05aa6'], red: ['#d1343a', '#f06065'], graphite: ['#4b5059', '#b4b9c2'],
  };
  const root = document.documentElement;
  const owner = { theme: root.getAttribute('data-theme') || 'auto', accent: root.getAttribute('data-accent') || 'theme' };

  function read() {
    try {
      const l = JSON.parse(localStorage.getItem('hd.look') || 'null');
      return l && typeof l === 'object' ? { theme: THEMES[l.theme] ? l.theme : null, accent: l.accent in ACCENTS ? l.accent : null } : { theme: null, accent: null };
    } catch {
      return { theme: null, accent: null };
    }
  }

  function apply() {
    const own = read();
    root.setAttribute('data-theme', own.theme || owner.theme);
    root.setAttribute('data-accent', own.accent || owner.accent);
  }

  function save(next) {
    const cur = { ...read(), ...next };
    try {
      if (!cur.theme && !cur.accent) localStorage.removeItem('hd.look');
      else localStorage.setItem('hd.look', JSON.stringify(cur));
    } catch {
      /* not stored: still applies to this page */
    }
    apply();
  }

  apply();
  return { THEMES, ACCENTS, owner, read, save, apply };
})();
