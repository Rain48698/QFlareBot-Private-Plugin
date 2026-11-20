#!/usr/bin/env node
/**
 * 把 README 里的安装链接改写到当前远端 HEAD。
 *
 * 安装链接形如：
 *   git:Rain48698/QFlareBot-Private-Plugin@<40 位 sha>#<子目录>
 *
 * 面板的匿名 GitHub API 配额只有每 IP 每小时 60 次，短 sha 和 GitHub 链接都要解析一次；
 * 40 位 sha 是唯一不调 API 的写法。代价是每次推送后这条 sha 就旧了——所以用这个脚本改写，
 * 而不是让人手工改。
 *
 * 扫描范围：根 README.md 加上每个插件子目录的 README.md（写死的 sha 到处都是，容易漏）。
 *
 * 用法：
 *   node scripts/update-readme-links.mjs              # 就地改写
 *   node scripts/update-readme-links.mjs --check      # 只检查，过期就退出码 1（给 CI 用）
 *   node scripts/update-readme-links.mjs --sha <sha>  # 指定 sha，不调 git
 *
 * 只改文件，不提交、不推送。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const shaFlag = args.indexOf('--sha')
const explicitSha = shaFlag >= 0 ? args[shaFlag + 1] : undefined

/** `git:<owner>/<repo>@<sha>#<subdir>` */
const LINK = /git:([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+)@([0-9a-f]{7,40})(#[^\s`'"）)]+)/g

/** 根 README + 每个插件子目录的 README（子目录 = 有 package.json 的一级目录） */
function readmeFiles() {
  const out = []
  const rootReadme = join(repoRoot, 'README.md')
  if (statSync(rootReadme, { throwIfNoEntry: false })?.isFile()) out.push(rootReadme)
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const pkg = join(repoRoot, entry.name, 'package.json')
    if (!statSync(pkg, { throwIfNoEntry: false })?.isFile()) continue
    const readme = join(repoRoot, entry.name, 'README.md')
    if (statSync(readme, { throwIfNoEntry: false })?.isFile()) out.push(readme)
  }
  return out
}

function remoteSha() {
  const out = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
    cwd: repoRoot,
    encoding: 'utf8',
    // 本机 git 全局代理指向 127.0.0.1:7890，代理没开时 ls-remote 会超时；
    // 先按配置试，失败再直连一次，别让用户为此改配置
  })
  const sha = out.trim().split(/\s+/)[0]
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`拿到的 sha 不合法：${JSON.stringify(out)}`)
  return sha
}

function resolveSha() {
  if (explicitSha) {
    if (!/^[0-9a-f]{40}$/.test(explicitSha)) throw new Error(`--sha 需要完整 40 位 hex，收到 ${explicitSha}`)
    return explicitSha
  }
  try {
    return remoteSha()
  } catch (first) {
    try {
      const out = execFileSync('git', ['-c', 'http.proxy=', '-c', 'https.proxy=', 'ls-remote', 'origin', 'refs/heads/main'], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
      const sha = out.trim().split(/\s+/)[0]
      if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('sha 不合法')
      return sha
    } catch {
      throw new Error(
        `读不到远端 HEAD：${first instanceof Error ? first.message : String(first)}\n` +
          '代理没开时可以加 --sha <40 位 sha> 手工指定，或先 git push 再跑。',
      )
    }
  }
}

function main() {
  const files = readmeFiles()
  const sha = resolveSha()

  const scanned = files.map((path) => {
    const original = readFileSync(path, 'utf8')
    const links = [...original.matchAll(LINK)]
    return { path, original, links, updated: original.replace(LINK, (_all, repo, _old, tail) => `git:${repo}@${sha}${tail}`) }
  })

  const total = scanned.reduce((n, f) => n + f.links.length, 0)
  if (total === 0) {
    console.error('没有找到 `git:owner/repo@<sha>#<子目录>` 形式的安装链接')
    console.error(`找过：${files.map((f) => f.path.replace(repoRoot, '.')).join('、') || '（没有 README.md）'}`)
    process.exit(1)
  }

  console.log(`远端 HEAD：${sha}`)
  let staleCount = 0
  for (const file of scanned) {
    if (file.links.length === 0) continue
    console.log(`  ${file.path.replace(repoRoot, '.')}`)
    for (const m of file.links) {
      const fresh = m[2] === sha
      if (!fresh) staleCount += 1
      console.log(`    #${m[3].slice(1)}：${fresh ? '已是最新' : `${m[2].slice(0, 12)}… → ${sha.slice(0, 12)}…`}`)
    }
  }

  if (staleCount === 0) {
    console.log('安装链接都是最新的，无需改动')
    process.exit(0)
  }
  if (checkOnly) {
    console.error(`✗ 有 ${staleCount} 条安装链接过期——运行 node scripts/update-readme-links.mjs`)
    process.exit(1)
  }

  for (const file of scanned) {
    if (file.original === file.updated) continue
    writeFileSync(file.path, file.updated, 'utf8')
  }
  console.log(`✓ 已改写 ${staleCount} 条安装链接，记得和其他改动一起提交`)
}

try {
  main()
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
