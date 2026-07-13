const VISIBLE_ACTION_COUNT = 2;

export function splitSectionActions(actions, visibleCount = VISIBLE_ACTION_COUNT) {
  return {
    visible: actions.slice(0, visibleCount),
    overflow: actions.slice(visibleCount),
  };
}
