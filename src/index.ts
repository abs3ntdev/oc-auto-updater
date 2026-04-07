import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

type Client = PluginInput["client"]

interface AutoUpdateOptions {
  packages?: string[]
  exclude?: string[]
}

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

function parseOptions(raw?: PluginOptions): AutoUpdateOptions {
  if (!raw) return {}
  const opts: AutoUpdateOptions = {}
  if (Array.isArray(raw.packages)) {
    opts.packages = raw.packages.filter((p): p is string => typeof p === "string")
  }
  if (Array.isArray(raw.exclude)) {
    opts.exclude = raw.exclude.filter((p): p is string => typeof p === "string")
  }
  return opts
}

function shouldUpdate(name: string, opts: AutoUpdateOptions): boolean {
  if (opts.packages?.length) {
    return opts.packages.includes(name)
  }
  if (opts.exclude?.length) {
    return !opts.exclude.includes(name)
  }
  return true
}

function getOpencodeDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) return path.join(localAppData, "opencode")
    return path.join(os.homedir(), "AppData", "Local", "opencode")
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "opencode")
  }
  const xdgCache = process.env.XDG_CACHE_HOME
  if (xdgCache) return path.join(xdgCache, "opencode")
  return path.join(os.homedir(), ".cache", "opencode")
}

function getOpencodeCacheDir(): string {
  return path.join(getOpencodeDir(), "packages")
}

function readWorkspacePackageName(workspaceDir: string): string | null {
  const pkgJsonPath = path.join(workspaceDir, "package.json")
  if (!fs.existsSync(pkgJsonPath)) return null
  try {
    const raw = fs.readFileSync(pkgJsonPath, "utf-8")
    const pkg = JSON.parse(raw) as WorkspacePackageJson
    return Object.keys(pkg.dependencies ?? {})[0] ?? null
  } catch {
    return null
  }
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
        const name = readWorkspacePackageName(scopedPath)
        if (name) {
          plugins.push({ name, workspaceDir: scopedPath })
        }
      }
    } else {
      if (!entry.endsWith("@latest")) continue
      const name = readWorkspacePackageName(entryPath)
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

function npmPackageUrl(packageName: string): string {
  const encoded = packageName.startsWith("@")
    ? packageName.replace("/", "%2F")
    : encodeURIComponent(packageName)
  return `${NPM_REGISTRY}/-/package/${encoded}/dist-tags`
}

async function fetchLatestVersion(packageName: string): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const resp = await fetch(npmPackageUrl(packageName), {
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
    execFile("bun", ["install", "--ignore-scripts"], { cwd: workspaceDir, timeout: INSTALL_TIMEOUT }, (err) => {
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
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n")

    for (const lockfile of ["package-lock.json", "bun.lockb", "bun.lock"]) {
      try { fs.unlinkSync(path.join(workspaceDir, lockfile)) } catch {}
    }

    return true
  } catch {
    return false
  }
}

interface ChangelogEntry {
  name: string
  from: string
  to: string
}

function writeChangelog(entries: ChangelogEntry[]): void {
  if (entries.length === 0) return
  const changelogPath = path.join(getOpencodeDir(), "plugin-changelog.md")
  const timestamp = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")
  const lines = [`## ${timestamp}\n`]
  for (const { name, from, to } of entries) {
    lines.push(`- **${name}**: ${from} -> ${to}`)
  }
  lines.push("")

  let existing = ""
  try {
    existing = fs.readFileSync(changelogPath, "utf-8")
  } catch {}

  const header = "# Plugin Update Changelog\n\n"
  const body = existing.startsWith(header)
    ? existing.slice(header.length)
    : existing

  fs.mkdirSync(path.dirname(changelogPath), { recursive: true })
  fs.writeFileSync(changelogPath, header + lines.join("\n") + "\n" + body)
}

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

export const AutoUpdatePlugin: Plugin = async ({ client }, options) => {
  const opts = parseOptions(options)
  log(client, "loaded")
  checkAndUpdateAll(client, opts).catch((err) => {
    log(client, `update check failed: ${err instanceof Error ? err.message : String(err)}`)
  })
  return {}
}
