# Putiorr Grab Profile Preset Design

Follow-up to browser sites per profile (issue #62 / PR #63), which is stacked
on the browser grab extension (#59 / PR #60).

**Superseded in part by `2026-07-25-ownership-cleanup-design.md` (issue #67).**
Phase 3 of that design made `profiles.rpc_path` nullable with a partial unique
index, so a Putiorr Grab profile no longer carries a derived `/grab/<slug>/rpc`
— it has no Transmission RPC endpoint at all, and the path answers every
request with a refusal. Phase 5 moved the preset's auto-remove default from the
browser to the store, so `POST /api/profiles` and `PUTIORR_PROFILES_JSON` get it
too. Everything else below still holds.

## Goal

Browser grabs get their own first-class profile preset instead of borrowing
the *arr presets. A "Putiorr Grab" profile is configured entirely for the
extension: which websites use it, which put.io folder, where it downloads
locally, and which download profile applies. The extension lists only these
profiles.

## App preset

`PROFILE_TYPES` gains:

```js
grab: {
  label: 'Putiorr Grab',
  root: '',
  autoRemoveCompleted: true,
  note: '…install/use guidance for the browser extension…',
}
```

It appears in the wizard's "App preset" select. `autoRemoveCompleted`
defaults on for the same reason prowlarr does: nothing imports browser grabs,
so completed transfers are removed from putiorr and put.io while the files
stay on disk.

## Wizard adapts to the preset

Selecting "Putiorr Grab" changes which steps render:

- **Shown:** display name, put.io folder, shared download folder, download
  profile, Browser sites, auto-remove completed, enabled.
- **Hidden:** the whole "RPC endpoint" step — RPC path, host from the *arr
  container, port, SSL. No *arr app connects to a grab profile, so these are
  noise. The "Copy settings" action and the *arr download-client note are
  hidden too.
- **Step numbering** renumbers so the visible steps read 1..N.
- ~~`rpc_path` is still required and unique in the store, so the wizard
  generates a hidden, stable one for grab profiles: `/grab/<slug>/rpc`, kept
  in sync with the display name the way the *arr presets keep theirs aligned.
  Uniqueness is already enforced server-side; a collision surfaces as the
  existing save error.~~ Superseded by #67 phase 3: `rpc_path` is nullable and a
  grab profile holds none. A duplicate display name collides on `slug`.
- Switching a grab profile to an *arr preset (or back) rewrites the derived
  fields exactly as preset switching does today.

## Profile card

A grab profile's card shows Browser sites, put.io folder, download folder,
and download profile — not the RPC endpoint. The badge/labels make the type
obvious.

## Extension only sees grab profiles

- `GET /api/profiles` gains an optional `?type=grab` filter (server-side, so
  the extension does not need to know the type vocabulary). The extension
  requests it when loading profiles; the read-only Profiles card and the
  default-profile select therefore list only grab profiles.
- `/api/grab` resolution is restricted to grab profiles for every path:
  the site match, the extension default, and an explicit right-click pick.
  A grab aimed at a non-grab profile is refused with a message naming the
  preset to use. Enabled-only still applies.
- The context menu is built from the same filtered list, so an *arr profile
  can never be picked.

## Field guide

The wizard's FIELD GUIDE panel gains entries for the grab-specific fields and
an "App preset" section for Putiorr Grab that explains the whole flow: what
the extension does, that it captures magnet and `.torrent` clicks, that sites
listed here route to this profile, and **how to install it** — from the
Chrome Web Store once published, and meanwhile by loading `extension/`
unpacked via `chrome://extensions` with Developer mode on. The extension's
options page needs the putiorr URL and a default profile.

The same guidance is added to the docs site (`docs/configuration.html`) as a
new "Browser grabs" section, since the extension is currently absent there.

## Migration

Nothing ships yet (both parent PRs are unmerged), so no data migration:
existing profiles keep their types, and `browser_domains` on a non-grab
profile simply stops being consulted. The dashboard shows the Browser sites
field only for grab profiles.

## Testing

- Server: `?type=grab` filtering; grab resolution refusing non-grab profiles
  on all three paths; the preset's auto-remove default.
- Web: testid coverage for the new preset option, the conditional step
  rendering, and the derived RPC path.
- Extension: profiles fetched with the filter; menu and default select built
  from grab profiles only.

## Delivery

Branch `feat/putiorr-grab-preset`, stacked on
`feat/extension-connection-profiles`; PR based there. Docs updated:
`extension/README.md`, root README, `docs/configuration.html`.
