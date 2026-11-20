#!/usr/bin/env node
/**
 * 把插件源码打包成可以在 Node 里直接 import 的 ESM，供 scripts/live/*.mjs 用。
 *
 * 为什么需要：插件源码 import 了 `@qqbot/sdk`（只发源码、不发 npm），
 * 而 `PluginDurableObject` 又继承 `cloudflare:workers`——Node 里没有这个模块。
 * esbuild 用和 qqbot-plugin build 同一个桩把它替换掉，产物就能在 Node 里跑。
 *
 * 用法：node scripts/live/build.mjs <插件目录> [输出文件]
 *   例：node scripts/live/build.mjs kkys            → .cache/kkys.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pluginDir = resolve(repoRoot, process.argv[2] ?? 'kkys')
const outFile = resolve(repoRoot, process.argv[3] ?? `.cache/${process.argv[2] ?? 'kkys'}.mjs`)

if (!existsSync(join(pluginDir, 'src', 'index.ts'))) {
  console.error(`${pluginDir}/src/index.ts 不存在`)
  process.exit(1)
}

const esbuildJs = join(pluginDir, 'node_modules', 'esbuild', 'bin', 'esbuild')
if (!existsSync(esbuildJs)) {
  console.error(`找不到 ${esbuildJs}——先在 ${pluginDir} 里 npm install`)
  process.exit(1)
}

const stub = join(pluginDir, 'node_modules', '@qqbot', 'plugin-cli', 'dist', 'stubs', 'cloudflare-workers.js')
if (!existsSync(stub)) {
  console.error(`找不到 cloudflare:workers 的桩：${stub}——先构建 QFlareBot 的 plugin-cli`)
  process.exit(1)
}

mkdirSync(dirname(outFile), { recursive: true })
// 直接跑 esbuild 的 JS 入口（node 可执行），不走 .bin 里的 .cmd 包装——
// Windows 上 spawn 一个 .cmd 会 EINVAL，开了 shell:true 又会触发 DEP0190 警告
execFileSync(
  process.execPath,
  [
    esbuildJs,
    join(pluginDir, 'src', 'index.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    `--outfile=${outFile}`,
    `--alias:cloudflare:workers=${stub}`,
    '--log-level=warning',
  ],
  { stdio: 'inherit', cwd: pluginDir },
)
console.log(`已打包 → ${outFile}`)
