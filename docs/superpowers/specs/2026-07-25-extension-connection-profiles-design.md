# Browser Sites Per Profile Design

Follow-up to the browser grab extension
(`2026-07-25-browser-grab-extension-design.md`, issue #59 / PR #60). Builds on
branch `feat/browser-grab-extension`.

**Superseded in part by `2026-07-25-ownership-cleanup-design.md` (issue #67).**
The site match runs over every Putiorr Grab profile, switched on or off — a
disabled profile still claims its sites and the grab is refused by name, rather
than falling through to the caller's default profile. Read "first enabled
profile whose `browser_domains` suffix-match" below as "first such profile".

## Goal

The sites-to-profile mapping is configured **in putiorr**, on the putiorr
profile itself, not in the extension. The extension configuration shows
putiorr's profiles (with their site assignments, read-only) and keeps only
its own concerns: connection, default profile, auto-capture.

## putiorr side

- Profiles gain a `browser_domains` field: the websites whose browser grabs
  route to this profile. Stored as a JSON array in a new `browser_domains`
  TEXT column (added via the existing `ensureColumn` migration path).
- Edited in putiorr's dashboard profile form as a comma-separated "Browser
  sites" input. Server-side normalization mirrors the extension's proven
  rules: lowercase, punycode via the URL parser, scheme/path/port and
  leading/trailing dots stripped, unmatchable entries rejected with a named
  error, underscore hostnames allowed, suffix matching includes subdomains.
- Normalization and matching live in a new server module
  (`src/transfer/browser-domains.js`) so the profile form and the grab
  resolution use the same code.

## Grab resolution moves server-side

`POST /api/grab` request gains optional fields; `profileId` becomes
optional:

```json
{
  "profileId": 4,          // optional: explicit context-menu pick
  "pageHost": "x.example", // hostname of the page the grab came from
  "defaultProfileId": 2,   // optional: the extension's configured default
  "magnet": "...",         // or torrentBase64 + filename, as before
  "sourceUrl": "..."
}
```

Resolution order: explicit `profileId` → first enabled profile whose
`browser_domains` suffix-match `pageHost` (profile id order) → 
`defaultProfileId` → 400 "no profile matches this site and no default
profile is configured". Explicit ids that don't exist stay 404.

The response now names the resolved profile so the extension can show it:

```json
{ "ok": true, "profile": { "id": 4, "name": "XZ" }, "transfer": { "id": 9, "name": "..." } }
```

Editing sites in putiorr applies to the very next grab — no cache staleness.

## Extension side

- The site-rules editor is removed. `chrome.storage.sync` keeps
  `baseUrl`, `defaultProfileId`, `autoCapture`, `profiles` (cached
  `{id, name}` list for the context menu); `rules` is retired.
- Grabs send `pageHost` (derived from the page URL in the worker) and
  `defaultProfileId`; an explicit context-menu pick sends `profileId`.
  Notifications use the `profile.name` from the response (the actually
  resolved profile), falling back to the cached name for transport errors.
- The options page lists the fetched putiorr profiles read-only, each with
  its browser sites, so the mapping is visible where grabs are configured.
- Legacy migration: if old `rules` exist in storage, the options page shows
  them once, read-only, with a note that sites now live on putiorr profiles
  and a dismiss action that deletes the key. Nothing is auto-pushed to
  putiorr.
- Unused rule machinery (`matchSiteRuleProfileId`, `resolveProfileId`,
  domain parsing in `lib/settings.js`) is removed from the extension along
  with its tests; the proven normalization/matching code moves to the server
  module.

## Testing

- Server: store round-trip of `browser_domains`; profile-input normalization
  (valid, unmatchable, punycode, underscore); grab resolution paths
  (explicit, site match incl. subdomain, default fallback, no-match 400,
  disabled profiles skipped); web profile form testids.
- Extension: worker payload shape, response-name notifications, menu cache;
  options read-only profile display and legacy-rules notice; migration
  drops `rules`.

## Delivery

Branch `feat/extension-connection-profiles` (stacked on
`feat/browser-grab-extension`); PR based on that branch, retargeting to
`main` when #60 merges. Docs updated: `extension/README.md` (sites are
configured in putiorr), root README section, and putiorr profile docs if
present.
