import type { Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import {
  parseOptions,
  shouldUpdate,
  getOpencodeCacheDir,
  discoverInstalledPlugins,
  getInstalledVersion,
  fetchLatestVersion,
  updateWorkspaceVersion,
  runInstall,
  writeChangelog,
  type AutoUpdateOptions,
  type ChangelogEntry,
} from "./updater.js"

type Client = PluginInput["client"]

function log(client: Client, message: string): void {
  void client.app
    .log({ body: { service: "oc-auto-updater", level: "info", message } })
    .catch(() => {})
}

async function checkAndUpdateAll(client: Client, opts: AutoUpdateOptions): Promise<void> {
  const cacheDir = getOpencodeCacheDir()
  const plugins = discoverInstalledPlugins(cacheDir)
  log(client, `found ${plugins.length} plugins in cache`)

  const updated: ChangelogEntry[] = []

  await Promise.all(
    plugins.map(async ({ name, workspaceDir }) => {
      if (!shouldUpdate(name, opts)) {
        log(client, `${name}: skipped (filtered by options)`)
        return
      }

      const installed = getInstalledVersion(name, workspaceDir)
      if (!installed) {
        log(client, `${name}: installed version not found`)
        return
      }

      const latest = await fetchLatestVersion(name)
      if (!latest) {
        log(client, `${name}: failed to fetch latest from npm`)
        return
      }

      if (installed === latest) {
        log(client, `${name}: up to date (${installed})`)
        return
      }

      log(client, `${name}: updating ${installed} -> ${latest}`)

      if (!updateWorkspaceVersion(workspaceDir, name, latest)) {
        log(client, `${name}: failed to update workspace package.json`)
        return
      }

      const success = await runInstall(workspaceDir)
      if (success) {
        updated.push({ name, from: installed, to: latest })
        log(client, `${name}: updated to ${latest}`)
      } else {
        log(client, `${name}: bun install failed`)
      }
    }),
  )

  writeChangelog(updated)
}

const server: Plugin = async ({ client }, options) => {
  const opts = parseOptions(options)
  log(client, "loaded")
  checkAndUpdateAll(client, opts).catch((err) => {
    log(client, `update check failed: ${err instanceof Error ? err.message : String(err)}`)
  })
  return {}
}

export default { id: "oc-auto-updater", server } satisfies PluginModule
