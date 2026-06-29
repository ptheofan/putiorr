// --- Light / dark theme toggle (persisted in localStorage; defaults to dark) ---
export const THEME_KEY = 'putiorr:theme';

export function applyTheme(theme) {
  const dark = theme !== 'light';
  document.documentElement.classList.toggle('wa-dark', dark);
  const toggle = document.querySelector('#themeToggle');
  if (!toggle) return;
  const icon = toggle.querySelector('wa-icon');
  if (icon) icon.name = dark ? 'moon' : 'sun';
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
