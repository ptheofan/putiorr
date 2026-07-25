# Putiorr Grab Preset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Putiorr Grab" app preset whose wizard is configured for the browser extension (sites, put.io folder, local folder, download profile) with the *arr RPC settings hidden, and an extension that sees only these profiles.

**Architecture:** A new `grab` entry in the web's `PROFILE_TYPES` drives conditional wizard rendering; `rpc_path` is derived and hidden for grab profiles so the store's uniqueness constraint is satisfied without exposing an irrelevant field. `GET /api/profiles?type=grab` filters server-side; `/api/grab` restricts every resolution path to grab profiles. The field guide and docs site explain the extension and its installation.

**Tech Stack:** unchanged — plain Node 22+ (`node --test`), vanilla web dashboard with WebAwesome components, Chrome MV3 extension, no dependencies.

**Spec:** `docs/superpowers/specs/2026-07-25-putiorr-grab-profile-preset-design.md` — tracking issue [#64](https://github.com/ptheofan/putiorr/issues/64).

**Branch:** `feat/putiorr-grab-preset`, stacked on `feat/extension-connection-profiles` (tip `a683554`).

**Conventions:** `pnpm test [file]`, `node scripts/lint.js`; commit per task; baseline 273 tests green.

---

### Task 1: Server — `?type=` filter and grab-only resolution

**Files:**
- Modify: `src/transmission/server.js` (the `GET /api/profiles` branch; `resolveGrabProfile`)
- Extend: `test/api-grab.test.js`

- [ ] **Step 1: Write failing tests**

In `test/api-grab.test.js` (its harness already creates profiles and a real server):
- `GET /api/profiles?type=grab` returns only profiles whose `type` is `grab`; without the param the full list is unchanged (including disabled — today's behavior); an unknown type returns `[]`.
- Grab resolution, with a `grab`-type profile G (sites `['x.example']`) and an *arr profile A (sites `['x.example']`, created first so it would win on id order):
  - `pageHost: 'x.example'` resolves to G, not A.
  - Explicit `profileId` of A → 400 whose message names the Putiorr Grab preset (assert a stable fragment, e.g. `/Putiorr Grab/`).
  - `defaultProfileId` pointing at A → the same 400.
  - Disabled G with matching sites is still skipped (existing rule).

- [ ] **Step 2: Run them, watch them fail.**

- [ ] **Step 3: Implement**

- In the `GET /api/profiles` branch, read `url.searchParams.get('type')` (the handler currently receives only `requestPath` — thread the parsed `URL` or the search string through `handleApi`, following how the method/path are already passed; keep the change minimal and note it). When present, filter the returned list by `profile.type === type`.
- Add a `GRAB_PROFILE_TYPE = 'grab'` constant. In `resolveGrabProfile`:
  - site matching runs over `listProfiles().filter((p) => p.type === GRAB_PROFILE_TYPE)`;
  - after an explicit or default profile is found, reject a non-grab profile with `400` and a message naming the preset, e.g. `` `${profile.name} is not a Putiorr Grab profile; set its App preset to Putiorr Grab in putiorr` ``.
  - Keep the existing tagged-union return shape and message-casing convention.

- [ ] **Step 4: Tests green; full `pnpm test && node scripts/lint.js`.**

- [ ] **Step 5: Commit** — `Filter profiles by type and restrict grabs to grab profiles (#64)`.

---

### Task 2: Dashboard — the preset and its wizard

**Files:**
- Modify: `src/web/constants.js` (`PROFILE_TYPES`), `src/web/index.html` (preset option + step markup/ids), `src/web/profiles.js` (conditional rendering, derived rpc path, card facts, help entries), `src/web/app.js` / `src/web/state.js` if new handles are needed
- Extend: `test/web-profile-testids.test.js`

- [ ] **Step 1: Write failing testid/source assertions** for: the `grab` option in the preset select; the grab branch in the wizard rendering function; the derived `/grab/<slug>/rpc` helper; the card fact set for grab profiles; the new help entries.

- [ ] **Step 2: Add the preset** to `PROFILE_TYPES` in `src/web/constants.js`:

```js
  grab: {
    label: 'Putiorr Grab',
    root: '',
    autoRemoveCompleted: true,
    note: 'Browser grabs come from the putiorr grab extension, not from an *arr app. List the sites this profile should claim, then point the extension at putiorr.',
  },
```

Add `<wa-option value="grab">Putiorr Grab</wa-option>` to the select in `index.html`.

- [ ] **Step 3: Conditional wizard rendering.** Add a function (e.g. `applyProfileTypeLayout()`) called from `syncWizardDefaultsForType` and `openProfileWizard` that, for `type === 'grab'`:
- hides the RPC endpoint step section and the client host/port/SSL fields (toggle a `hidden` attribute on the section element — give it an id if it lacks one);
- hides the "Copy settings" control and any *arr-specific note;
- renumbers the visible `.step-label`s so they read 1..N (derive from the visible sections rather than hard-coding);
- and reverses all of it for non-grab presets.

`getWizardPayload` keeps sending `rpc_path`/host/port/ssl — for grab profiles it sends the derived path and the existing defaults, so no server change is needed.

- [ ] **Step 4: Derived RPC path.** In the grab branch, set `rpc_path` to `/grab/<slug>/rpc` derived from the display name (reuse `slugify`), refreshed when the name changes, exactly as the *arr presets keep theirs aligned. Never shown.

- [ ] **Step 5: Card facts.** For a grab profile, render Browser sites / put.io folder / download folder / download profile and omit the RPC endpoint fact.

- [ ] **Step 6: Field guide.** Add `WIZARD_HELP` entries for the grab-specific fields, and extend the App-preset entry so choosing Putiorr Grab explains: what the extension does (captures magnet and `.torrent` clicks and sends them here), that sites listed on this profile route to it, and how to install the extension — from the Chrome Web Store once published, and until then by loading the repo's `extension/` folder unpacked at `chrome://extensions` with Developer mode enabled, then setting the putiorr URL and a default profile in its options.

- [ ] **Step 7: Tests green; full suite + lint. Commit** — `Add the Putiorr Grab app preset to the profile wizard (#64)`.

---

### Task 3: Extension — grab profiles only

**Files:**
- Modify: `extension/options.js` (profile fetch), `extension/background.js` (menu source, if it reads the cached list)
- Extend: `test/extension-options.test.js`, `test/extension-background.test.js`

- [ ] **Step 1: Failing tests** — the options page requests `/api/profiles?type=grab`; a response containing only grab profiles populates the card and the default select; the context menu is built from the cached (grab-only) list.
- [ ] **Step 2: Implement** — append the query param to the profiles fetch. The stored `profiles` cache is already whatever was fetched, so the menu follows automatically; verify and pin rather than assume.
- [ ] **Step 3: Empty-state wording** — when putiorr returns no grab profiles, the status should say so and name the fix ("no Putiorr Grab profiles in putiorr — create one with the Putiorr Grab preset"), rather than the current generic "no enabled profiles".
- [ ] **Step 4: Tests green; full suite + lint. Commit** — `Extension: list only Putiorr Grab profiles (#64)`.

---

### Task 4: Docs

**Files:** `extension/README.md`, root `README.md`, `docs/configuration.html`

- [ ] Update `extension/README.md`: profiles must use the **Putiorr Grab** preset; the wizard hides the *arr RPC settings for them; the options page and right-click menu list only grab profiles; resolution refuses non-grab profiles. Keep every other claim accurate (verify against code).
- [ ] Root README: one sentence in the Browser Extension section about the preset.
- [ ] `docs/configuration.html`: add a "Browser grabs" section matching the surrounding markup conventions — what the extension is, creating a Putiorr Grab profile, listing sites, and installing the extension (Chrome Web Store when published; unpacked meanwhile).
- [ ] Verify claims against code; `pnpm test && node scripts/lint.js`. Commit — `Document the Putiorr Grab preset (#64)`.

---

### Task 5: Final review + PR

- [ ] Final whole-branch review against base `a683554`.
- [ ] Push; open PR with base `feat/extension-connection-profiles`, `Closes #64`, noting the stack.
