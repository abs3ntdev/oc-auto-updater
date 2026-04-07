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

function findWorkspaceDir(packageName: string, cacheDir: string): string | null {
  const scope = packageName.startsWith("@") ? packageName.split("/")[0] : null
  const searchDir = scope ? path.join(cacheDir, scope) : cacheDir
  const baseName = scope ? packageName.slice(scope.length + 1) : packageName

  if (!fs.existsSync(searchDir)) return null

  for (const entry of fs.readdirSync(searchDir)) {
    if (!entry.startsWith(baseName + "@")) continue
    const candidate = path.join(searchDir, entry)
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate
  }

  return null
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

async function checkAndUpdate(packages: string[], client: Client): Promise<void> {
  const cacheDir = getOpencodeCacheDir()
  log(client, `checking updates, cache: ${cacheDir}`)

  await Promise.all(
    packages.map(async (pkg) => {
      const workspaceDir = findWorkspaceDir(pkg, cacheDir)
      if (!workspaceDir) {
        log(client, `${pkg}: not found in cache`)
        return
      }

      const installed = getInstalledVersion(pkg, workspaceDir)
      if (!installed) {
        log(client, `${pkg}: installed version not found`)
        return
      }

      const latest = await fetchLatestVersion(pkg)
      if (!latest) {
        log(client, `${pkg}: failed to fetch latest from npm`)
        return
      }

      if (installed === latest) {
        log(client, `${pkg}: up to date (${installed})`)
        return
      }

      log(client, `${pkg}: updating ${installed} -> ${latest}`)

      if (!updateWorkspaceVersion(workspaceDir, pkg, latest)) {
        log(client, `${pkg}: failed to update workspace package.json`)
        return
      }

      const success = await runInstall(workspaceDir)
      log(client, `${pkg}: ${success ? `updated to ${latest}` : "bun install failed"}`)
    }),
  )
}

export function createAutoUpdatePlugin(packages: string[]): Plugin {
  return async ({ client }) => {
    log(client, `loaded, watching ${packages.length} packages`)
    void checkAndUpdate(packages, client)
    return {}
  }
}
