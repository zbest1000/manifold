// Applies the saved colour theme before the first paint (loaded synchronously
// from <head>, kept as a same-origin file so it also works under a strict CSP).
// Preference: localStorage 'tc.theme' = 'system' | 'light' | 'dark' (default system).
// Keep in sync with src/lib/theme.js.
(function () {
  var pref = 'system';
  try {
    pref = localStorage.getItem('tc.theme') || 'system';
  } catch (e) {
    /* storage unavailable: follow the system */
  }
  var dark = pref === 'dark' || (pref !== 'light' && !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches));
  var root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
})();
