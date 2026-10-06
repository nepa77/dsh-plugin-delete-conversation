#!/usr/bin/env node
/**
 * 校验文档与包内文件一致：
 *   1. README.md 里提到的每个**仓库内相对路径**都真实存在；
 *   2. package.json 的 `files` 列表里每一项都存在（打包不会因为写错路径而漏文件）。
 *
 * 仓库根目录就是插件包目录，所以"文档里写的路径"与"包里的文件"必须对得上；
 * 这类不一致很容易引入、很难发现，因此放进 CI。
 *
 * 运行：node tools/check-readme-paths.mjs
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const EXTENSIONS = 'md|mjs|js|json|py|ps1|yml|yaml|svg|webp|png|txt'
const PATTERNS = [
  // `some/path.ext` — 反引号里的仓库内路径
  new RegExp('`([A-Za-z0-9_./\\\\-]+\\.(?:' + EXTENSIONS + '))`', 'g'),
  // ![alt](some/path.webp) 与 [text](some/path.md)
  /!\[[^\]]*\]\(([^)]+)\)/g,
  /\[[^\]]+\]\(([^)]+)\)/g,
]
// 不是仓库内相对路径的形态：URL、锚点、占位符、绝对路径、通配符、版本号占位。
const NOT_A_REPO_PATH = /^(?:https?:|mailto:|#|\/|~|[A-Za-z]:[\\/])|[*?<>|…$]/

/** 从一段 markdown 里收集候选相对路径。 */
function candidatesFrom(text) {
  const found = new Set()
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1].replace(/\\/g, '/').trim()
      if (candidate.length === 0) continue
      if (NOT_A_REPO_PATH.test(candidate)) continue
      if (candidate.split('/').includes('..')) continue
      found.add(candidate)
    }
  }
  return found
}

async function exists(relative) {
  try {
    await stat(path.join(ROOT, relative))
    return true
  } catch {
    return false
  }
}

const problems = []

const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8')
const readmePaths = candidatesFrom(readme)
for (const candidate of [...readmePaths].sort()) {
  if (!(await exists(candidate))) problems.push(`README.md 提到的路径不存在：${candidate}`)
}
console.log(`README.md：检查了 ${readmePaths.size} 个仓库内相对路径`)

const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
const files = manifest.files ?? []
for (const entry of files) {
  if (!(await exists(entry))) problems.push(`package.json 的 files 列了不存在的项：${entry}`)
}
for (const required of ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml']) {
  if (!(await exists(required))) problems.push(`包根缺少必需文件：${required}`)
}
console.log(`package.json：检查了 files 的 ${files.length} 项与 4 个必需文件`)

if (problems.length > 0) {
  console.log('')
  for (const problem of problems) console.log('  ' + problem)
  process.exit(1)
}
console.log('全部通过：文档提到的路径与包内文件一致')
