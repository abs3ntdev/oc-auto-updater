import type { TuiPlugin, TuiPluginModule, TuiPluginApi, TuiDialogSelectOption } from "@opencode-ai/plugin/tui"
import {
  getOpencodeCacheDir,
  discoverInstalledPlugins,
  getPluginVersionInfos,
  updatePlugin,
  writeChangelog,
  type PluginVersionInfo,
  type ChangelogEntry,
} from "./updater.js"

const UPDATE_ALL_VALUE = "__update_all__"

function buildPluginOptions(
  plugins: PluginVersionInfo[],
): TuiDialogSelectOption<string>[] {
  const updatable = plugins.filter((p) => p.updateAvailable)
  const upToDate = plugins.filter((p) => !p.updateAvailable)

  const options: TuiDialogSelectOption<string>[] = []

  if (updatable.length > 0) {
    options.push({
      title: "Update All",
      value: UPDATE_ALL_VALUE,
      description: `${updatable.length} update${updatable.length > 1 ? "s" : ""}`,
      category: "Actions",
    })
  } else {
    options.push({
      title: "All up to date",
      value: "__info__",
      description: "No updates available",
      category: "Info",
    })
  }

  for (const p of updatable) {
    options.push({
      title: p.name,
      value: p.name,
      description: `${p.installed} -> ${p.latest}`,
      category: "Updates Available",
    })
  }

  for (const p of upToDate) {
    options.push({
      title: p.name,
      value: p.name,
      description: `${p.installed} = ${p.latest}`,
      category: "Up to Date",
    })
  }

  return options
}

async function handleUpdateSelection(
  api: TuiPluginApi,
  selection: string,
  plugins: PluginVersionInfo[],
): Promise<void> {
  const toUpdate =
    selection === UPDATE_ALL_VALUE
      ? plugins.filter((p) => p.updateAvailable)
      : plugins.filter((p) => p.name === selection && p.updateAvailable)

  if (selection === "__info__" || toUpdate.length === 0) {
    api.ui.toast({ message: "No updates available for this plugin", variant: "info" })
    api.ui.dialog.clear()
    return
  }

  api.ui.toast({
    message: `Updating ${toUpdate.length} plugin${toUpdate.length > 1 ? "s" : ""}...`,
    variant: "info",
  })
  api.ui.dialog.clear()

  const results: ChangelogEntry[] = []
  const failures: string[] = []

  for (const plugin of toUpdate) {
    const entry = await updatePlugin(plugin)
    if (entry) {
      results.push(entry)
    } else {
      failures.push(plugin.name)
    }
  }

  writeChangelog(results)

  if (failures.length > 0) {
    api.ui.toast({
      message: `Failed to update: ${failures.join(", ")}`,
      variant: "error",
      duration: 5000,
    })
  }

  if (results.length > 0) {
    const summary = results.map((e) => `${e.name}: ${e.from} -> ${e.to}`).join(", ")
    api.ui.toast({
      message: `Updated: ${summary}`,
      variant: "success",
      duration: 5000,
    })

    // Prompt to restart OpenCode to load updated plugins
    api.ui.dialog.replace(() =>
      api.ui.DialogConfirm({
        title: "Restart Required",
        message: `${results.length} plugin${results.length > 1 ? "s" : ""} updated. Exit now to apply changes?`,
        onConfirm: () => {
          api.ui.dialog.clear()
          api.command.trigger("app.exit")
        },
        onCancel: () => {
          api.ui.dialog.clear()
        },
      }),
    )
  } else if (failures.length === 0) {
    api.ui.toast({ message: "All plugins are up to date", variant: "success" })
  }
}

const tui: TuiPlugin = async (api, _options, _meta) => {
  const unsubscribe = api.command.register(() => [
    {
      title: "Update Plugins",
      value: "update-plugins",
      description: "Check installed plugins for updates",
      category: "Plugins",
      slash: {
        name: "update-plugins",
        aliases: ["up"],
      },
      onSelect: () => {
        api.ui.toast({ message: "Checking plugin versions...", variant: "info" })

        const cacheDir = getOpencodeCacheDir()
        const installed = discoverInstalledPlugins(cacheDir)

        if (installed.length === 0) {
          api.ui.toast({ message: "No installed plugins found", variant: "warning" })
          return
        }

        getPluginVersionInfos(installed).then((plugins) => {
          const options = buildPluginOptions(plugins)

          api.ui.dialog.replace(() =>
            api.ui.DialogSelect<string>({
              title: "Installed Plugins",
              placeholder: "Search plugins...",
              options,
              onSelect: (opt) => {
                void handleUpdateSelection(api, opt.value, plugins)
              },
            }),
          )
        }).catch(() => {
          api.ui.toast({
            message: "Failed to check plugin versions",
            variant: "error",
          })
        })
      },
    },
  ])

  api.lifecycle.onDispose(() => {
    unsubscribe()
  })
}

export default { id: "oc-auto-updater", tui } satisfies TuiPluginModule
