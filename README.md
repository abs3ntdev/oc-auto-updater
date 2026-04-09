# oc-auto-updater

An [OpenCode](https://opencode.ai) plugin that keeps your installed plugins up to date.

## Features

- **Auto-update on startup** -- silently checks all installed plugins against npm and updates any that are outdated
- **`/update-plugins` command** -- interactive TUI command to view installed plugin versions and selectively update them
- **Changelog** -- records all updates to `~/.local/share/opencode/plugin-changelog.md`

## Install

### New install

```
opencode plugin add oc-auto-updater
```

This automatically registers both the server plugin (auto-update) and the TUI plugin (`/update-plugins` command).

### Existing users upgrading

If you already have `oc-auto-updater` installed from a previous version, the server plugin will continue working as before. To enable the new `/update-plugins` command, add it to your TUI config:

**`~/.config/opencode/tui.json`**

```json
{
  "plugin": ["oc-auto-updater"]
}
```

Or remove and re-add the plugin:

```
opencode plugin remove oc-auto-updater
opencode plugin add oc-auto-updater
```

## Usage

### Automatic updates

The server plugin runs in the background on every OpenCode startup. It checks all installed plugins against the npm registry and updates any that have newer versions available. No configuration required.

### Interactive updates

Type `/update-plugins` (or `/up`) in the TUI to open the plugin manager. It shows:

- All installed plugins with their current and latest versions
- An **Update All** option when updates are available
- Select a specific plugin to update just that one

After updating, you'll be prompted to exit OpenCode so the new versions are loaded on next launch.

## Configuration

You can optionally filter which plugins are auto-updated by passing options in your `opencode.json`:

```json
{
  "plugin": [
    ["oc-auto-updater", {
      "packages": ["opencode-claude-auth", "some-other-plugin"]
    }]
  ]
}
```

| Option | Type | Description |
|--------|------|-------------|
| `packages` | `string[]` | Only update these plugins (whitelist) |
| `exclude` | `string[]` | Skip these plugins (blacklist) |

If neither option is set, all installed plugins are checked.

## License

MIT
