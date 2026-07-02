// --- Light / dark theme toggle (persisted in localStorage; defaults to dark) ---
export const THEME_KEY = 'putiorr:theme';

export function applyTheme(theme) {
  const dark = theme !== 'light';
  document.documentElement.classList.toggle('wa-dark', dark);
  const toggle = document.querySelector('#themeToggle');
  if (!toggle) return;
  const icon = toggle.querySelector('wa-icon');
  // Show the icon of the mode you'll switch TO: a clear crescent moon in light
  // mode (switch to dark), a sun in dark mode (switch to light). Showing the sun
  // in light mode read as a gear because its rays look like cog teeth when small.
  if (icon) icon.name = dark ? 'sun' : 'moon';
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
}

export function storedTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function initTheme() {
  applyTheme(storedTheme());

  document.querySelector('#themeToggle')?.addEventListener('click', () => {
    const next = document.documentElement.classList.contains('wa-dark') ? 'light' : 'dark';
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore storage failures (private mode) */
    }
    applyTheme(next);
  });
}
