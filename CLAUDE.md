# TabCentral

Firefox add-on (Manifest V3). Plain JavaScript, HTML and CSS: no bundler, no build step, no npm dependencies. Scripts are loaded with `<script>` tags.

## Before handing work over

- Run `npx web-ext@8 lint` in this folder. It must report 0 errors and 0 warnings.
- Add a line under `## [Unreleased]` in `CHANGELOG.md` for user-visible changes. Keep it short and about what changed, not how.
- Don't bump the version for every change. When asked for a build or release, bump `version` in `manifest.json` (semver), turn `[Unreleased]` into that version with today's date, and build with `npx web-ext@8 build`. AMO rejects an upload whose version is not higher than the last one.
- Commit or push only when asked.

## Things to keep in mind

- The add-on ID in `manifest.json` (`browser_specific_settings.gecko.id`) is permanent. Never change it: stored data and AMO updates are tied to it.
- Files that are not part of the add-on (docs, configs) must be listed in `ignoreFiles` in `web-ext-config.mjs`, or they end up in the .xpi.
- `nova.css` and `shortcuts.js` are shared with TabShush (`../tabshush`, a separate repository). The copies must stay identical: when changing one, apply the same change to `../tabshush/shared/nova.css` and `../tabshush/shortcuts.js`, and say so.
- CSS: use the `--nova-*` tokens for colours, radii and shadows. Use rem for margins, paddings and font sizes; px is fine for borders, gaps, icon sizes and fixed widths.
- New files: tabs for indentation, LF line endings. Match the surrounding code style.
- Every permission must be justified in the README's permission table; AMO reviewers check this.
- The repository lives on a network share (M: is `\\micro\Home\Localhost`), which is why it is listed under `safe.directory` in the global git config.
