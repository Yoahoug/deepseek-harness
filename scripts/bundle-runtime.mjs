#!/usr/bin/env node
/**
 * Generate a portable production runtime bundle for DSH Launcher.
 *
 * The bundle contains built lib/dist files, runtime package metadata, the
 * lockfile and production patches. It excludes node_modules, source files,
 * tests and devDependencies.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const MANIFEST = 'bundle-manifest.json'

function parseArgs(argv) {
  let source = process.cwd()
  let output = resolve(process.cwd(), 'runtime-bundle')
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source') source = argv[++i]
    else if (argv[i] === '--output') output = resolve(argv[++i])
    else throw new Error('unknown argument: ' + argv[i])
  }
  return { source: resolve(source), output }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function productionPackage(path) {
  const value = readJson(path)
  delete value.devDependencies
  delete value.scripts
  return JSON.stringify(value, null, 2) + '\n'
}

function copyFile(source, target) {
  mkdirSync(resolve(target, '..'), { recursive: true })
  writeFileSync(target, readFileSync(source))
}

function copyTree(source, target, options = {}) {
  const excludeMaps = options.excludeMaps === true
  if (statSync(source).isFile()) {
    if (!excludeMaps || !source.endsWith('.map')) copyFile(source, target)
    return
  }
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test' || entry.name === 'tests') continue
    copyTree(join(source, entry.name), join(target, entry.name), { excludeMaps })
  }
}

function copyPackage(sourceRoot, rel, outputRoot) {
  const source = join(sourceRoot, rel)
  const packagePath = join(source, 'package.json')
  if (!existsSync(packagePath)) return
  const manifest = readJson(packagePath)
  const target = join(outputRoot, rel)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), productionPackage(packagePath))
  for (const name of ['lib', 'config', 'assets', 'bin', 'prebuilds', 'dist']) {
    const candidate = join(source, name)
    if (existsSync(candidate)) copyTree(candidate, join(target, name), { excludeMaps: name === 'dist' })
  }
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin || {})
  for (const bin of bins) {
    if (typeof bin !== 'string' || bin.startsWith('/') || bin.includes('..')) continue
    const candidate = join(source, bin)
    if (existsSync(candidate)) copyFile(candidate, join(target, bin))
  }
}

function copyWorkspacePackages(sourceRoot, outputRoot) {
  for (const group of ['packages', 'vendor', 'native']) {
    const groupRoot = join(sourceRoot, group)
    if (!existsSync(groupRoot)) continue
    const walk = (dir, relDir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || ['node_modules', 'test', 'tests'].includes(entry.name)) continue
        const child = join(dir, entry.name)
        const rel = join(relDir, entry.name)
        if (existsSync(join(child, 'package.json'))) copyPackage(sourceRoot, rel, outputRoot)
        walk(child, rel)
      }
    }
    walk(groupRoot, group)
  }
}

function cleanPrevious(output) {
  const path = join(output, MANIFEST)
  if (!existsSync(path)) return
  let previous = null
  try { previous = readJson(path) } catch { /* regenerate below */ }
  for (const file of previous?.files || []) {
    if (typeof file.path === 'string' && !file.path.includes('..')) rmSync(join(output, file.path), { force: true })
  }
  rmSync(path, { force: true })
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function listFiles(root, current = root) {
  const result = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === MANIFEST || entry.name === 'node_modules') continue
    const path = join(current, entry.name)
    if (entry.isDirectory()) result.push(...listFiles(root, path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}

export function bundleRuntime({ source, output }) {
  const root = resolve(source)
  const dest = resolve(output)
  const required = [
    'apps/cli/lib/bin.js',
    'apps/cli/package.json',
    'apps/web/dist/index.html',
    'apps/web/package.json',
    'package.json',
    'pnpm-lock.yaml',
  ]
  for (const file of required) {
    if (!existsSync(join(root, file))) throw new Error('missing production input: ' + file)
  }
  mkdirSync(dest, { recursive: true })
  cleanPrevious(dest)
  copyFile(join(root, 'pnpm-lock.yaml'), join(dest, 'pnpm-lock.yaml'))
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) copyFile(join(root, 'pnpm-workspace.yaml'), join(dest, 'pnpm-workspace.yaml'))
  if (existsSync(join(root, 'patches'))) copyTree(join(root, 'patches'), join(dest, 'patches'))
  writeFileSync(join(dest, 'package.json'), productionPackage(join(root, 'package.json')))
  copyPackage(root, 'apps/cli', dest)
  copyPackage(root, 'apps/web', dest)
  copyTree(join(root, 'apps/web/dist'), join(dest, 'apps/web/dist'), { excludeMaps: true })
  copyWorkspacePackages(root, dest)

  const entries = listFiles(dest).map((path) => {
    const relativePath = relative(dest, path).split(sep).join('/')
    const stat = statSync(path)
    return { path: relativePath, size: stat.size, sha256: sha256(path) }
  }).sort((a, b) => a.path.localeCompare(b.path))
  const bundleHash = createHash('sha256')
    .update(entries.map((entry) => entry.path + '\0' + entry.size + '\0' + entry.sha256 + '\n').join(''))
    .digest('hex')
  const manifest = {
    schema: 1,
    bundleHash,
    sourceVersion: readJson(join(root, 'package.json')).version || null,
    generatedAt: new Date().toISOString(),
    files: entries,
  }
  writeFileSync(join(dest, MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const result = bundleRuntime(parseArgs(process.argv.slice(2)))
    console.log('runtime bundle generated: ' + result.bundleHash)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
