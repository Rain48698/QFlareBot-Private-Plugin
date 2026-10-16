#!/usr/bin/env node
/**
 * 校验「声明清单」manifest.json 与构建产物 dist/manifest.json 是否一致。
 *
 * 面板安装时读的是仓库里的 manifest.json（声明清单），机器人构建时又按源码重新抽一份；两者不一致，
 * 这次构建会失败（见 docs/publish.md）。改完源码记得先 `npm run sync` 再提交。
 *
 * 用法：node scripts/check-manifest.mjs <插件目录>      例：node scripts/check-manifest.mjs jrys
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** 键排序后的 JSON：与字段顺序无关，与 deploy-policy.mjs 的 stableStringify 同一套规则 */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
    .join(',')}}`
}

const dir = path.resolve(process.argv[2] ?? '.')
const read = async (rel) => JSON.parse(await readFile(path.join(dir, rel), 'utf8'))
const label = path.basename(dir)

let declared
try {
  declared = await read('manifest.json')
} catch {
  console.error(`✗ ${label}：读不到 manifest.json——先运行 npm run sync`)
  process.exit(1)
}
let built
try {
  built = await read('dist/manifest.json')
} catch {
  console.error(`✗ ${label}：读不到 dist/manifest.json——先运行 npm run build`)
  process.exit(1)
}

if (stable(declared) === stable(built)) {
  // 顺带把清单内容打出来：这个脚本只保证两份清单一致，不保证内容是你要的。
  // 从模板复制来的插件如果忘了重写 src/index.ts，命令列表会原样留着模板的东西——只有打出来才看得见。
  const cmds = (declared.commands ?? []).map((c) => `/${c.name}`).join('、') || '（没有命令）'
  console.log(`✓ ${label}：声明清单与源码一致`)
  console.log(`    name=${declared.name} version=${declared.version} apiVersion=${declared.apiVersion ?? '(未写)'}`)
  console.log(`    命令：${cmds}`)
  process.exit(0)
}

const keys = [...new Set([...Object.keys(declared), ...Object.keys(built)])].filter((k) => stable(declared[k]) !== stable(built[k]))
console.error(`✗ ${label}：manifest.json 与 dist/manifest.json 不一致（${keys.join('、')}）`)
console.error('  运行 npm run sync 后提交新的 manifest.json')
process.exit(1)
