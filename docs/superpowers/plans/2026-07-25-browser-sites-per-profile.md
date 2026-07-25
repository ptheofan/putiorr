# Browser Sites Per Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** putiorr profiles declare which websites route to them (`browser_domains`), `/api/grab` resolves the profile server-side, and the extension drops its local site-rules machinery.

**Architecture:** A new pure server module `src/transfer/browser-domains.js` (normalization + matching, ported from the extension's proven `lib/settings.js`/`lib/resolve.js` code) is used by both the profile input path and grab resolution. The store gains a JSON-array `browser_domains` TEXT column. The dashboard profile form gains a "Browser sites" input. The extension sends `pageHost` + `defaultProfileId` (or explicit `profileId`) and displays the server-resolved profile name from the response.

**Tech Stack:** unchanged — plain Node 22+ (`node --test`), Chrome MV3, no dependencies.

**Spec:** `docs/superpowers/specs/2026-07-25-extension-connection-profiles-design.md` — tracking issue [#62](https://github.com/ptheofan/putiorr/issues/62).

**Branch:** `feat/extension-connection-profiles` (stacked on `feat/browser-grab-extension`).

**Conventions:** tests via `pnpm test [test/<file>.test.js]`, lint via `node scripts/lint.js` (covers `extension/`, `src/`, `test/`, `scripts/`). Commit after every green task. All existing 229 tests must stay green throughout.

---

### Task 1: `src/transfer/browser-domains.js` + store column + profile API

**Files:**
- Create: `src/transfer/browser-domains.js`
- Create: `test/browser-domains.test.js`
- Modify: `src/state/store.js` (column + serialization), `src/transmission/server.js` (`normalizeProfileInput`)
- Extend: `test/state-store.test.js` (round-trip), `test/api-grab.test.js` or a small profile-API case

- [ ] **Step 1: Write failing tests for the pure module**

`test/browser-domains.test.js` — port the semantics proven in `test/extension-options.test.js` (parseRuleDomains cases) and `test/extension-resolve.test.js` (matching cases). Exports under test:

```js
import { normalizeBrowserDomains, matchProfileByHost } from '../src/transfer/browser-domains.js';
```

- `normalizeBrowserDomains(input)` — accepts a comma-separated string OR an array; returns `{ domains, errors, warnings }`:
  - normalization identical to the extension's `normalizeDomain`: lowercase, punycode via `new URL`, scheme/path/port stripped, leading/trailing dots stripped, dedupe
  - unmatchable entries (wildcards anywhere, empty labels, edge hyphens) → `errors` naming the entry; `*.x.example` gets the "plain x.example already covers subdomains" hint
  - single-label domains → `warnings`; bracketed IPv6 exempt; underscores allowed
  - empty/omitted input → `{ domains: [], errors: [], warnings: [] }`
- `matchProfileByHost(profiles, host)` — first profile (array order) whose `browser_domains` array suffix-matches `host` (exact or `.domain`), host normalized the same way; returns the profile or `undefined`; never throws on malformed rows (non-array `browser_domains` skipped).

Copy the concrete test cases from the extension suites: punycode (`bücher.example` rule vs `xn--bcher-kva.example` host), `media_server.lan`, subdomain match, `notx.example` non-match, malformed rows `[null]`/`domains: 5`.

- [ ] **Step 2: Run and watch them fail** — `pnpm test test/browser-domains.test.js` fails on missing module.

- [ ] **Step 3: Implement the module**

Port from `extension/lib/settings.js` (`normalizeDomain`, `MATCHABLE_DOMAIN`, the parse loop) and `extension/lib/resolve.js` (suffix match). Keep it dependency-free and side-effect-free. This is a copy, not an import — `src/` must not import from `extension/` (different deployment surface); note that in a file comment.

- [ ] **Step 4: Store column + serialization**

In `src/state/store.js`:
- Schema/migration: alongside the existing `ensureColumn` calls (~line 322): `this.ensureColumn('profiles', 'browser_domains', 'TEXT')`.
- `createProfile` INSERT (~line 623): add the `browser_domains` column and value `input.browser_domains === undefined ? null : JSON.stringify(input.browser_domains)`.
- `updateProfile` (~line 648): add `browser_domains` to the `allowed` list; serialize arrays to JSON in the normalized patch the same way.
- `normalizeProfileRow` (~line 56): parse it back:

```js
const browserDomains = (() => {
  try {
    const parsed = JSON.parse(row.browser_domains ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((d) => typeof d === 'string') : [];
  } catch {
    return [];
  }
})();
```

and include `browser_domains: browserDomains, browserDomains` in the returned object (both key styles, matching the row's existing dual-style fields).

- [ ] **Step 5: Profile input normalization**

In `src/transmission/server.js` `normalizeProfileInput` (~line 1206): accept `browser_domains` / `browserDomains` (string or array). Run `normalizeBrowserDomains`; if `errors.length`, throw `new Error(errors.join(' '))` (surfaces as the profile form's 400); else `output.browser_domains = domains`. Import the module at the top of the file.

- [ ] **Step 6: Tests green, then extend integration tests**

Add to `test/state-store.test.js`: create/update round-trip of `browser_domains` (array in → array out; absent → `[]`; corrupt text in DB → `[]`). Add one API-level case (harness from `test/api-grab.test.js` style): `POST /api/profiles` with `browserDomains: 'x.example, bücher.example'` → row has `['x.example','xn--bcher-kva.example']`; with `'*.x.example'` → 400 naming the entry.

- [ ] **Step 7: Full suite + lint, commit**

`pnpm test && node scripts/lint.js` → green. Commit: `Add browser_domains to profiles with server-side normalization (#62)`.

---

### Task 2: `/api/grab` server-side resolution

**Files:**
- Modify: `src/transmission/server.js` (`handleGrab`, ~line 1075)
- Extend: `test/api-grab.test.js`

- [ ] **Step 1: Write failing tests**

Using the existing harness (default profile exists; create extra profiles via `harness.store.createProfile({...})` as in current tests, now with `browser_domains`):
1. grab with `pageHost: 'x.example'` and NO `profileId`, where profile B has `browser_domains: ['x.example']` → 200, transfer created for B, response `profile.name` is B's name.
2. subdomain: `pageHost: 'tracker.x.example'` → B.
3. no site match + `defaultProfileId` of the default profile → 200 via default, `profile.name` matches.
4. no site match + no `defaultProfileId` → 400 `{ error: 'no profile matches this site and no default profile is configured' }`.
5. disabled profile with matching domains is skipped (falls to default/400).
6. explicit `profileId` still wins over a conflicting site match; unknown explicit id still 404; unknown `defaultProfileId` used as fallback → 404 `Profile not found`.
7. existing tests updated: response shape now includes `profile: { id, name }` (assert it in one happy-path test; other tests unchanged assertions still pass since fields are additive).

- [ ] **Step 2: Watch them fail**, then **Step 3: implement** in `handleGrab`:

Replace the current mandatory-profileId block with:

```js
      const explicitId = body.profileId;
      let profile;
      if (explicitId !== undefined && explicitId !== null && String(explicitId) !== '') {
        const profileId = Number(explicitId);
        if (!Number.isInteger(profileId) || profileId <= 0) {
          jsonResponse(res, 400, { error: 'profileId is required' }, this.sessionId);
          return;
        }
        profile = this.service.store.findProfileById(profileId);
      } else {
        const pageHost = String(body.pageHost ?? '').trim();
        profile = pageHost
          ? matchProfileByHost(this.service.store.listProfiles(), pageHost)
          : undefined;
        if (!profile) {
          const defaultId = Number(body.defaultProfileId);
          if (Number.isInteger(defaultId) && defaultId > 0) {
            profile = this.service.store.findProfileById(defaultId);
            if (!profile) {
              jsonResponse(res, 404, { error: 'Profile not found' }, this.sessionId);
              return;
            }
          } else {
            jsonResponse(res, 400, { error: 'no profile matches this site and no default profile is configured' }, this.sessionId);
            return;
          }
        }
      }
      if (!profile) {
        jsonResponse(res, 404, { error: 'Profile not found' }, this.sessionId);
        return;
      }
```

Notes: `listProfiles()` already filters to enabled profiles, which implements the "disabled skipped" rule; explicit-id path deliberately does NOT filter (existing behavior: disabled explicit target → 400 "is disabled" from `requireProfile`). Keep all subsequent validation (magnet/torrentBase64, warning, logging) unchanged; add `pageHost` to the log line (bounded like `sourceUrl`). Response gains the resolved profile:

```js
      jsonResponse(res, 200, {
        ok: true,
        profile: { id: profile.id, name: profile.name },
        transfer: { ... },
      }, this.sessionId);
```

- [ ] **Step 4: Full suite + lint, commit** — `Resolve grab profiles server-side via browser_domains (#62)`.

---

### Task 3: Dashboard profile form "Browser sites" field

**Files:**
- Modify: `src/web/profiles.js` (+ `src/web/index.html` if the form fields live there)
- Extend: `test/web-profile-testids.test.js`

- [ ] **Step 1:** Read how existing profile fields are wired (`putio_folder_name` pattern: field definition ~line 71, card fact ~line 241, wizard field ~line 295/339/369, payload ~line 389, and the corresponding testids test). Add a "Browser sites" text input following the exact same pattern: comma-separated, placeholder `x.example, z.example`, help text "Browser grabs from these sites use this profile; subdomains match automatically. Leave empty for none." Payload key: `browserDomains` (string — the server normalizes and errors on bad entries; the form surfaces the server's error message like other validation failures). Card display: show the stored `browser_domains` joined with `, ` or "None".
- [ ] **Step 2:** Extend `test/web-profile-testids.test.js` with the new testid(s), following its existing style.
- [ ] **Step 3:** Full suite + lint. Manual check happens with the smoke test in Task 5's checklist. Commit: `Add Browser sites field to the profile form (#62)`.

---

### Task 4: Extension — server-side resolution, read-only sites display

**Files:**
- Modify: `extension/background.js`, `extension/content.js` (payload only if needed — pageUrl already flows), `extension/options.js`, `extension/options.html`, `extension/lib/settings.js`, `extension/lib/resolve.js`
- Extend/prune: `test/extension-background.test.js`, `test/extension-options.test.js`, `test/extension-resolve.test.js`

- [ ] **Step 1: Worker (TDD in the stub harness)**

`background.js` `handleGrab`:
- Stop resolving via rules. Build the request: explicit pick → `profileId`; otherwise include `pageHost` (hostname derived from `payload.pageUrl` — the existing derivation) and `defaultProfileId: settings.defaultProfileId || undefined`.
- Success notification name: `result.profile?.name`, falling back to the cached `settings.profiles` lookup (explicit picks during transport errors), then `profile #N`/generic.
- The "no profile" pre-flight check changes: the worker no longer knows whether a site matches — only refuse locally when there is no explicit pick, no default, AND the server is the one to decide? No: send anyway; the server's 400 message ("no profile matches this site and no default profile is configured") is the user feedback. Delete the local `resolveProfileId` call and the "No profile matches this site" notification branch.
- `SYNC_DEFAULTS` (in `lib/settings.js`): drop `rules`. Migration: on worker startup/installed, `chrome.storage.sync.remove('rules')` is NOT done silently — leave the key in place for the options page's legacy notice (Step 2); the worker simply ignores it.
- Update tests: payload shape assertions (pageHost/defaultProfileId sent; profileId only on explicit pick), response-name notification, rules ignored.

- [ ] **Step 2: Options page (TDD in the stub DOM harness)**

- Remove the rules editor (table, add-rule button, `parseRuleDomains` usage). Keep: baseUrl, credentials, Test & load, default profile select, auto-capture.
- After a successful profile load, render a read-only list: each fetched profile's name + its `browser_domains` joined (`browserDomains`/`browser_domains` from `/api/profiles` — handle both key styles) or "no sites". Static text via `textContent` only.
- Legacy notice: on restore, if `sync.rules` is a non-empty array, render it read-only (domains → cached profile name or `#id`) with the message "Site rules now live in putiorr: set Browser sites on each profile there, then dismiss this." and a Dismiss button that `chrome.storage.sync.remove('rules')` and hides the notice. Save does NOT write `rules` anymore (drift-guard test updated to the new key set).
- Update/prune options tests accordingly (rule-editor tests removed, read-only display + legacy notice + dismiss covered).

- [ ] **Step 2b: Restyle with putiorr's design language (user request)**

While rebuilding options.html, adopt the dashboard's look with plain CSS —
no React, no build step (user chose this over a React rewrite):
- New `extension/options.css` linked from options.html. COPY the needed
  pieces from `src/web/styles/` (tokens from `01-tokens.css`, base/type
  rules, form styling from `04-forms.css`, panel/card treatment from
  `03-panels.css`) — the extension cannot reference `src/web` at runtime;
  keep only the rules the page uses, note the source files in a comment.
- Layout: a header with the extension icon + title; a "Connection" card
  (URL, credentials, Test button + status); a "Profiles" card (read-only
  fetched-profile list with their browser sites, styled as rows); a
  "Behavior" card (default profile select, auto-capture toggle); the legacy
  rules notice as a dismissible callout.
- Styled selects/inputs/buttons per the dashboard's form styles; status/
  error styling reuses the dashboard's semantic colors; support light and
  dark via the same `prefers-color-scheme` approach the dashboard tokens
  use.
- No inline styles; all static markup in options.html, all dynamic content
  still `textContent`-only. The stub-DOM tests keep passing (they assert
  behavior, not styling) — update selectors only where the structure
  legitimately changed.

- [ ] **Step 3: Prune unused lib code**

Remove from `extension/lib/settings.js`: `parseRuleDomains` and its helpers now unused (keep `validateBaseUrl`, `SYNC_DEFAULTS`, and anything the options page still imports). Remove from `extension/lib/resolve.js`: `matchSiteRuleProfileId`, `resolveProfileId`, `normalizeDomain` export IF nothing imports them anymore (verify with grep — `sanitizeProfiles`, `isMagnetLink`, `isTorrentLink` stay). Prune their tests. The deleted logic lives on in `src/transfer/browser-domains.js` with its own suite.

- [ ] **Step 4: Full suite + lint, commit** — `Extension: server-resolved grab profiles, read-only sites display (#62)`.

---

### Task 5: Docs + verification

**Files:** `extension/README.md`, `README.md`, and the putiorr docs page if profiles are documented (`docs/configuration.html` — check).

- [ ] Update `extension/README.md`: Configure section (sites are set in putiorr's profile form, options page shows them read-only), resolution order (right-click pick → putiorr's site match → extension default), API section (`pageHost`/`defaultProfileId`/optional `profileId`, response `profile`), Verify The Setup checklist (add: set Browser sites on a profile in putiorr, click a magnet on that site with a different default → lands in the site's profile). Root README: one sentence in the Browser Extension section. Check `docs/configuration.html` for a profile-fields list to extend.
- [ ] `pnpm test && node scripts/lint.js` green; confirm every doc claim against code.
- [ ] Commit: `Document browser sites per profile (#62)`.

---

### Task 6: Final review + PR

- [ ] Final whole-branch review (base: `feat/browser-grab-extension` tip `4978163`).
- [ ] Push and open PR with base `feat/browser-grab-extension`, title `Browser sites per putiorr profile (#62)`, body linking the spec/plan and noting it retargets to `main` when #60 merges. `Closes #62`.
