import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

type Client = PluginInput["client"]

const NPM_REGISTRY = "https://registry.npmjs.org"
const FETCH_TIMEOUT = 5000
const INSTALL_TIMEOUT = 30_000

interface NpmDistTags {
  latest?: string
  [tag: string]: string | undefined
}

interface WorkspacePackageJson {
  dependencies?: Record<string, string>
}

function getOpencodeCacheDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "opencode", "packages")
  }
  const xdgCache = process.env.XDG_CACHE_HOME
  if (xdgCache) return path.join(xdgCache, "opencode", "packages")
  return path.join(os.homedir(), ".cache", "opencode", "packages")
}

function discoverInstalledPlugins(cacheDir: string): Array<{ name: string; workspaceDir: string }> {
  const plugins: Array<{ name: string; workspaceDir: string }> = []

  if (!fs.existsSync(cacheDir)) return plugins

  for (const entry of fs.readdirSync(cacheDir)) {
    const entryPath = path.join(cacheDir, entry)
    if (!fs.statSync(entryPath).isDirectory()) continue

    if (entry.startsWith("@")) {
      for (const scopedEntry of fs.readdirSync(entryPath)) {
        if (!scopedEntry.endsWith("@latest")) continue
        const scopedPath = path.join(entryPath, scopedEntry)
        if (!fs.statSync(scopedPath).isDirectory()) continue
        const pkgJsonPath = path.join(scopedPath, "package.json")
        if (!fs.existsSync(pkgJsonPath)) continue
        const raw = fs.readFileSync(pkgJsonPath, "utf-8")
        const pkg = JSON.parse(raw) as WorkspacePackageJson
        const name = Object.keys(pkg.dependencies ?? {})[0]
        if (name) {
          plugins.push({ name, workspaceDir: scopedPath })
        }
      }
    } else {
      if (!entry.endsWith("@latest")) continue
      const pkgJsonPath = path.join(entryPath, "package.json")
      if (!fs.existsSync(pkgJsonPath)) continue
      const raw = fs.readFileSync(pkgJsonPath, "utf-8")
      const pkg = JSON.parse(raw) as WorkspacePackageJson
      const name = Object.keys(pkg.dependencies ?? {})[0]
      if (name) {
        plugins.push({ name, workspaceDir: entryPath })
      }
    }
  }

  return plugins
}

function getInstalledVersion(packageName: string, workspaceDir: string): string | null {
  try {
    const pkgJsonPath = path.join(workspaceDir, "node_modules", packageName, "package.json")
    if (!fs.existsSync(pkgJsonPath)) return null
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

async function fetchLatestVersion(packageName: string): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const url = `${NPM_REGISTRY}/-/package/${encodeURIComponent(packageName)}/dist-tags`
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
    if (!resp.ok) return null
    const tags = (await resp.json()) as NpmDistTags
    return tags.latest ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function runInstall(workspaceDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("bun", ["install"], { cwd: workspaceDir, timeout: INSTALL_TIMEOUT }, (err) => {
      resolve(!err)
    })
  })
}

function updateWorkspaceVersion(workspaceDir: string, packageName: string, version: string): boolean {
  try {
    const pkgJsonPath = path.join(workspaceDir, "package.json")
    const raw = fs.readFileSync(pkgJsonPath, "utf-8")
    const pkg = JSON.parse(raw) as WorkspacePackageJson

    if (!pkg.dependencies) pkg.dependencies = {}
    pkg.dependencies[packageName] = version
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2))

    for (const lockfile of ["package-lock.json", "bun.lockb", "bun.lock"]) {
      try { fs.unlinkSync(path.join(workspaceDir, lockfile)) } catch {}
    }

    return true
  } catch {
    return false
  }
}

function log(client: Client, message: string): void {
  void client.app
    .log({ body: { service: "oc-auto-updater", level: "info", message } })
    .catch(() => {})
}

async function checkAndUpdateAll(client: Client): Promise<void> {
  const cacheDir = getOpencodeCacheDir()
  const plugins = discoverInstalledPlugins(cacheDir)
  log(client, `found ${plugins.length} plugins in cache`)

  await Promise.all(
    plugins.map(async ({ name, workspaceDir }) => {
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
      log(client, `${name}: ${success ? `updated to ${latest}` : "bun install failed"}`)
    }),
  )
}

export const AutoUpdatePlugin: Plugin = async ({ client }) => {
  log(client, "loaded")
  void checkAndUpdateAll(client)
  return {}
}
