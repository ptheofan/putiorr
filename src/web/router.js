import { setHidden } from './util.js';

// --- Sidebar routing (hash-based, no server rewrites needed) ---
export const ROUTES = ['topology', 'downloads', 'download-profiles', 'profiles', 'help'];

export function currentRoute() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return ROUTES.includes(hash) ? hash : 'downloads';
}

export function applyRoute() {
  const route = currentRoute();
  for (const view of document.querySelectorAll('[data-route-view]')) {
    setHidden(view, view.dataset.routeView !== route);
  }
  for (const link of document.querySelectorAll('.nav-item')) {
    const active = link.dataset.route === route;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

export function initRouter() {
  window.addEventListener('hashchange', applyRoute);
  applyRoute();
}
