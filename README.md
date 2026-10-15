# TabCentral

A Firefox add-on for managing your open tabs across windows, in the style of Firefox View's Open tabs page, but with a little more pizzazz.

## Features

- All windows side by side as cards, in 1 to 4 columns, with fuzzy search.
- Select tabs with click, Ctrl and Shift, and drag them within or between windows.
- Full tab group support: create, rename, recolour, collapse, move and ungroup.
- Merge windows, sort tabs, gather a domain's tabs or all groups into one window, and close duplicates.
- Rename windows.
- Store tabs as bookmarks and reopen them later.
- Undo and redo, including for closed tabs.
- Backup and restore of all windows as a file.
- Keyboard navigation and screen reader support.
- Light and dark mode.

## Permissions

| Permission | Why |
| --- | --- |
| tabs | List, move, select and close your tabs |
| tabGroups | Show and manage tab groups |
| bookmarks | Store tabs in a bookmark folder |
| sessions | Window names, and reopening closed tabs for undo |
| storage | Keep your settings |
| clipboardWrite | Copy tab addresses |

TabCentral collects no data. Everything stays in your browser.

## Install

Not on addons.mozilla.org yet, but aiming to! Until then:

1. Download the `.xpi` file from the newest [release](https://github.com/appel/tabcentral/releases). These are pre-releases, signed by Mozilla.
2. Open it in Firefox: drag it onto a Firefox window, or go to `about:addons`, click the gear icon and choose **Install Add-on From File**.

To get a newer version, install the newer `.xpi` the same way. Your settings stay. Requires Firefox 139 or later.

To try it from source instead, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on** and pick `manifest.json`. Temporary add-ons are removed when Firefox closes.

## Development

Plain JavaScript, HTML and CSS without a build step. With Node.js installed:

```
npx web-ext@8 lint     # check the add-on
npx web-ext@8 run      # start Firefox with the add-on loaded
npx web-ext@8 build    # package it into web-ext-artifacts/
```

## Credits

- Icons from [Bootstrap Icons](https://icons.getbootstrap.com), © The Bootstrap Authors, MIT License.
- Domain grouping uses the [Public Suffix List](https://publicsuffix.org), Mozilla Public License 2.0.
- TabCentral was made with AI.

## License

[MIT](LICENSE), except `psl.dat` (MPL 2.0).
