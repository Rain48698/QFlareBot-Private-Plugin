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

/**
 * 这个 sha 指向的那次提交里，插件子目录的内容与 HEAD 是否一致。
 *
 * 不能直接比 `linkSha === HEAD`——改链接本身会产生一个新提交，链接于是永远比 HEAD 慢一个，
 * 追不上自己。真正要保证的是「用户装到的代码和仓库当前的一样」，判据是子目录的 git tree 相同：
 * 只改了 README / CI 的提交不会让链接失效，改了插件源码才会。
 */
function subdirUnchanged(sha, subdir) {
  const treeOf = (rev) => {
    try {
      return execFileSync('git', ['rev-parse', `${rev}:${subdir}`], { cwd: repoRoot, encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  }
  const atSha = treeOf(sha)
  const atHead = treeOf('HEAD')
  if (!atSha || !atHead) return false
  return atSha === atHead
}

function main() {
  const files = readmeFiles()
  const sha = resolveSha()

  const scanned = files.map((path) => {
    const original = readFileSync(path, 'utf8')
    return { path, original, links: [...original.matchAll(LINK)] }
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
      const subdir = m[3].slice(1)
      const same = subdirUnchanged(m[2], subdir)
      if (!same) staleCount += 1
      const target = m[2] === sha ? '本地 HEAD（那次提交还没推上去）' : `${sha.slice(0, 12)}…`
      console.log(
        `    #${subdir}：${same ? `插件代码已是当前版本（链接停在 ${m[2].slice(0, 12)}…）` : `子目录有改动，应指向 ${target}`}`,
      )
    }
  }

  if (staleCount === 0) {
    console.log('安装链接指向的插件代码都是当前版本，无需改动')
    process.exit(0)
  }
  if (checkOnly) {
    console.error(`✗ 有 ${staleCount} 条安装链接指向旧的插件代码——运行 node scripts/update-readme-links.mjs`)
    process.exit(1)
  }

  let rewritten = 0
  for (const file of scanned) {
    // 只给「子目录真的变了」的链接换 sha，其余原样留着（少制造无意义 diff）
    const next = file.original.replace(LINK, (all, repo, old, tail) =>
      subdirUnchanged(old, tail.slice(1)) ? all : `git:${repo}@${sha}${tail}`,
    )
    if (next === file.original) continue
    writeFileSync(file.path, next, 'utf8')
    rewritten += 1
  }
  console.log(`✓ 已更新 ${rewritten} 个 README 里的安装链接，记得和其他改动一起提交`)
}

try {
  main()
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
