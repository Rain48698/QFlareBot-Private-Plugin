#!/usr/bin/env node
/**
 * 把 README 里的安装链接改写到当前远端 HEAD。
 *
 * 安装链接形如：
 *   git:Rain48698/QFlareBot-Private-Plugin@<40 位 sha>#<子目录>
 *
 * 面板的匿名 GitHub API 配额只有每 IP 每小时 60 次，短 sha 和 GitHub 链接都要解析一次；
 * 40 位 sha 是唯一不调 API 的写法。代价是每次推送后这条 sha 就旧了——所以用这个脚本改写，
 * 而不是让人手工 e。
 *
 * 用法：
 *   node scripts/update-readme-links.mjs              # 改 README.md
 *   node scripts/update-readme-links.mjs --check      # 只检查，过期就退出码 1（给 CI 用）
 *   node scripts/update-readme-links.mjs --sha <sha>  # 指定 sha，不调 git
 *
 * 只改文件，不提交、不推送。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readmePath = join(repoRoot, 'README.md')

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const shaFlag = args.indexOf('--sha')
const explicitSha = shaFlag >= 0 ? args[shaFlag + 1] : undefined

/** `git:<owner>/<repo>@<sha>#<subdir>` */
const LINK = /git:([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+)@([0-9a-f]{7,40})(#[^\s`'"）)]+)/g

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
  const original = readFileSync(readmePath, 'utf8')
  const links = [...original.matchAll(LINK)]
  if (links.length === 0) {
    console.error('README.md 里没找到 `git:owner/repo@<sha>#<子目录>` 形式的安装链接')
    process.exit(1)
  }

  const sha = resolveSha()
  const stale = links.filter((m) => m[2] !== sha)
  const updated = original.replace(LINK, (_all, repo, _old, tail) => `git:${repo}@${sha}${tail}`)

  console.log(`远端 HEAD：${sha}`)
  for (const m of links) {
    const subdir = m[3].slice(1)
    const state = m[2] === sha ? '已是最新' : `${m[2].slice(0, 12)}… → ${sha.slice(0, 12)}…`
    console.log(`  #${subdir}：${state}`)
  }

  if (stale.length === 0) {
    console.log('README 的安装链接都是最新的，无需改动')
    process.exit(0)
  }

  if (checkOnly) {
    console.error(`✗ README 里有 ${stale.length} 条安装链接过期——运行 node scripts/update-readme-links.mjs`)
    process.exit(1)
  }

  writeFileSync(readmePath, updated, 'utf8')
  console.log(`✓ 已改写 ${stale.length} 条安装链接，记得和其他改动一起提交`)
}

try {
  main()
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
