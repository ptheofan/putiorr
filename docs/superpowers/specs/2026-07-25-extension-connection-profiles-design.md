# Extension Connection Profiles Design

Follow-up to the browser grab extension
(`2026-07-25-browser-grab-extension-design.md`, issue #59 / PR #60). Builds on
branch `feat/browser-grab-extension`.

## Goal

Replace the extension's single global connection + flat site-rules table with
named **grab profiles**. A grab profile is the object the user sees and edits
in the extension configuration, and the object the context menu lists.

## Data model

```json
{
  "id": 3,
  "name": "XZ",
  "baseUrl": "http://nas:9091",
  "putiorrProfileId": 4,
  "domains": ["x.example", "z.example"]
}
```

- No per-profile credentials. The existing global optional Basic auth
  username/password (in `chrome.storage.local`) applies to every profile's
  connection.
- `domains` declares which websites belong to the profile — same
  normalization, validation, and suffix-match semantics as today's site
  rules.
- Profiles may point at different putiorr instances (each owns its
  `baseUrl`).

Storage (`chrome.storage.sync`): `grabProfiles` (array of the shape above),
`defaultGrabProfileId`, `autoCapture`. The old keys (`baseUrl`,
`defaultProfileId`, `rules`, `profiles`) are superseded.

## Resolution

Explicit context-menu pick → first grab profile whose `domains` match the
page hostname (reusing `matchSiteRuleProfileId`) → default grab profile.
Notifications and the context menu show the grab profile's `name`.

## Migration

A pure `migrateLegacySync(sync)` in `extension/lib/settings.js` converts the
old schema when found: the global connection + `defaultProfileId` become a
"Default" grab profile (no domains); each old rule becomes a grab profile
named after its target putiorr profile (name taken from the old cached
`profiles` list, falling back to `profile #N`), reusing the old global
`baseUrl`. The worker runs it on `onInstalled`/`onStartup` and writes the new
shape back (removing old keys); the options page also applies it on restore
so the editor never shows stale shapes.

## Options page

The profile list is the page's primary content: one card/row per grab
profile with name, putiorr URL, a per-profile "Test & load putiorr profiles"
button feeding that profile's target dropdown, and its domains field.
Global controls: username/password, default grab profile select,
auto-capture toggle. All existing validation carries over per profile
(root-only URL, domain normalization with visible write-back, unmatchable
domains rejected, transactional save, sanitized shapes written).

A profile with no domains is valid (reachable via default or context menu
only). Domains claimed by two profiles: first match wins by profile order;
the editor warns on overlap.

## Server

Untouched. `/api/grab` already receives everything per-request.

## Testing

Extend the existing node test suites: pure logic (migration, sanitization,
resolution) in `test/extension-resolve.test.js` / `test/extension-options.test.js`
style; worker behavior (menus from grab profiles, migration write-back,
grab flow to the profile's baseUrl) in the `test/extension-background.test.js`
stub harness; options editor round-trips in the stub DOM harness.

## Delivery

Branch `feat/extension-connection-profiles` (stacked on
`feat/browser-grab-extension`); PR based on that branch, retargeting to
`main` when #60 merges. Docs (`extension/README.md`, root README section)
updated to describe profiles instead of site rules.
