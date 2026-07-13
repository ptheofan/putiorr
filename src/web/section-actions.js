import { splitSectionActions } from './section-action-split.js';

export function initSectionActionOverflow(root = document) {
  const disclosures = [];

  for (const actions of root.querySelectorAll('.section-actions')) {
    const { overflow: overflowActions } = splitSectionActions([...actions.children]);
    if (overflowActions.length === 0) continue;

    const disclosure = root.createElement('details');
    disclosure.className = 'section-actions-overflow';

    const toggle = root.createElement('summary');
    toggle.className = 'icon-button section-actions-more';
    toggle.setAttribute('aria-label', 'More actions');
    toggle.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="5" r="2"></circle>
        <circle cx="12" cy="12" r="2"></circle>
        <circle cx="12" cy="19" r="2"></circle>
      </svg>
    `;

    const menu = root.createElement('div');
    menu.className = 'section-actions-menu';
    menu.append(...overflowActions);
    menu.addEventListener('click', () => disclosure.removeAttribute('open'));

    disclosure.append(toggle, menu);
    actions.append(disclosure);
    disclosures.push(disclosure);
  }

  if (disclosures.length === 0) return;

  root.addEventListener('click', (event) => {
    for (const disclosure of disclosures) {
      if (!disclosure.contains(event.target)) disclosure.removeAttribute('open');
    }
  });
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const disclosure of disclosures) disclosure.removeAttribute('open');
  });
}
