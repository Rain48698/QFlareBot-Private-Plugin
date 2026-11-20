/**
 * kkys 插件真机验证：真实网络 + 真实站点，走完整链路。
 *
 * 不用桩 fetch——这里就是要看真站点当前长什么样、解析正则还对不对。
 * 每一步都打印实际结果，失败时打印抓到的页面片段，方便判断是「站点改版」还是「代码错」。
 *
 * 用法：node scripts/live/kkys-chain.mjs [片名] [集数]
 *
 * 打包路径：优先 KKYS_BUNDLE 环境变量，否则 .cache/kkys.mjs（先跑 node scripts/live/build.mjs kkys）。
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BUNDLE_PATH =
  process.env.KKYS_BUNDLE ??
  join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), '.cache', 'kkys.mjs')

const BASE = 'https://www.kkys01.com'

const HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
}

// Windows 上 import() 不收裸路径，必须转成 file:// URL
const mod = await import(pathToFileURL(BUNDLE_PATH).href)

let pass = 0
let fail = 0
function ok(label, detail = '') {
  pass++
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
}
function bad(label, detail = '') {
  fail++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(name) {
  console.log(`\n=== ${name} ===`)
}

async function httpGet(url, cookie) {
  const headers = cookie ? { ...HEADERS, cookie } : { ...HEADERS }
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(25_000) })
  return { status: res.status, text: await res.text() }
}

// 与插件内部同款的内存 KV（真实实现用 ctx.kv，这里只需要 getJSON/put）
function memoryKv() {
  const map = new Map()
  return {
    async getJSON(key) {
      const v = map.get(key)
      return v === undefined ? null : JSON.parse(v)
    },
    async put(key, value) {
      map.set(key, JSON.stringify(value))
    },
    data: map,
  }
}

const logger = {
  debug: () => {},
  info: (m, d) => console.log(`    [info] ${m}${d ? ` ${JSON.stringify(d)}` : ''}`),
  warn: (m, d) => console.log(`    [warn] ${m}${d ? ` ${JSON.stringify(d)}` : ''}`),
  error: (m, d) => console.log(`    [error] ${m}${d ? ` ${JSON.stringify(d)}` : ''}`),
}

const keyword = process.argv[2] ?? '斗罗大陆'
const epNumber = Number(process.argv[3] ?? 1)

// ---------------------------------------------------------------------------

section('1. 首页与反爬挑战')
let home = await httpGet(BASE)
console.log(`    HTTP ${home.status}，${home.text.length} 字节`)
let cookie = ''
if (mod.isChallenge(home.status, home.text)) {
  ok('首页返回反爬挑战（850 或页面含 cdndefend）')
  const parsed = mod.parseCdndefendChallenge(home.text)
  if (!parsed) {
    bad('挑战页解析失败——正则与站点当前格式不匹配')
    const idx = home.text.indexOf('a0_0x')
    console.log(`    命中位置：${idx}；片段：${JSON.stringify(home.text.slice(Math.max(0, idx - 80), idx + 260))}`)
  } else {
    ok('挑战页解析成功', `c=${parsed.c.slice(0, 16)}… n1=${parsed.n1}`)
    const started = Date.now()
    const i = mod.solveCdndefend(parsed.c, parsed.n1, 1_000_000)
    const ms = Date.now() - started
    if (i < 0) {
      bad('PoW 在 100 万次内未命中——挑战算法或条件变了')
    } else {
      // 用 node:crypto 独立复核，确认解出来的 i 真的满足条件
      const { createHash } = await import('node:crypto')
      const digest = createHash('sha1').update(parsed.c + i).digest()
      const good = digest[parsed.n1] === 0xb0 && digest[parsed.n1 + 1] === 0x0b
      if (good) ok('PoW 命中且经 node:crypto 复核', `i=${i}，耗时 ${ms}ms`)
      else bad('PoW 返回的 i 通不过独立校验', `i=${i}`)
      cookie = `cdndefend_js_cookie=${parsed.c}${i}`
    }
  }
} else if (home.status === 200) {
  ok('首页直接 200（当前没触发反爬）')
} else {
  bad(`首页返回意外状态 ${home.status}`)
}

section('2. 带 Cookie 取首页 + 提取 t 参数')
if (cookie) {
  home = await httpGet(BASE, cookie)
  console.log(`    HTTP ${home.status}，${home.text.length} 字节`)
}
if (mod.isChallenge(home.status, home.text)) {
  bad('带上 Cookie 仍被反爬拦截')
} else {
  ok('Cookie 有效', `HTTP ${home.status}`)
}
const t = mod.parseTParam(home.text)
if (t) ok('t 参数提取成功', t)
else {
  bad('t 参数提取失败——首页结构可能变了')
  const idx = home.text.indexOf('name="t"')
  console.log(`    name="t" 命中位置：${idx}；片段：${JSON.stringify(home.text.slice(Math.max(0, idx - 120), idx + 200))}`)
}

section(`3. 搜索「${keyword}」`)
if (!t) {
  bad('没有 t 参数，跳过')
} else {
  const searchUrl = `${BASE}/search?t=${encodeURIComponent(t)}&k=${encodeURIComponent(keyword)}`
  const res = await httpGet(searchUrl, cookie)
  console.log(`    HTTP ${res.status}，${res.text.length} 字节`)
  if (res.status !== 200) {
    bad('搜索请求失败')
  } else {
    const results = mod.parseSearchResults(res.text)
    if (results.length === 0) {
      bad('解析出 0 条结果——站点结构变了，或关键词真没结果')
      const idx = res.text.indexOf('search-result-item')
      console.log(`    search-result-item 命中位置：${idx}；片段：${JSON.stringify(res.text.slice(Math.max(0, idx - 100), idx + 400))}`)
    } else {
      ok(`解析出 ${results.length} 条结果`)
      for (const r of results.slice(0, 5)) {
        console.log(`      · ${r.title || '(空标题!)'} | ${r.year} ${r.country} ${r.genre} | vodId=${r.vodId || '(空)'}`)
        if (!r.title) bad('  有结果的标题为空——title class 解析失配')
        if (!r.detailUrl) bad('  有结果的详情链接为空')
      }
      const filtered = results.filter((r) => mod.isRelevantTitle(r.title, keyword))
      ok('相关性过滤', `${results.length} → ${filtered.length} 条`)
    }

    section('4. 详情页解析')
    const picked = results[0]
    if (!picked) {
      bad('没有结果可用于详情页测试')
    } else {
      const detailRes = await httpGet(picked.detailUrl, cookie)
      console.log(`    HTTP ${detailRes.status}，${detailRes.text.length} 字节`)
      if (detailRes.status !== 200) {
        bad('详情页请求失败')
      } else {
        const detail = mod.parseDetail(detailRes.text, picked.detailUrl)
        if (!detail.title) bad('详情页标题解析为空')
        else ok('标题解析', detail.title)
        if (detail.lines.length === 0) {
          bad('线路解析为 0 条——source-item / episode-item 结构变了')
          const si = detailRes.text.indexOf('source-item')
          const ei = detailRes.text.indexOf('episode-item')
          console.log(`    source-item 位置=${si}，episode-item 位置=${ei}`)
          console.log(`    片段：${JSON.stringify(detailRes.text.slice(Math.max(0, si - 60), si + 400))}`)
        } else {
          const total = detail.lines.reduce((n, l) => n + l.episodes.length, 0)
          ok('线路解析', `${detail.lines.length} 条线路、${total} 集`)
          for (const l of detail.lines.slice(0, 4)) {
            console.log(`      · ${l.name}${l.sublabel ? `（${l.sublabel}）` : ''} → ${l.episodes.length} 集，id=${l.id}`)
          }
          const ordered = mod.orderLines(detail.lines)
          ok('线路排序（4K 排后）', ordered.map((l) => l.name).slice(0, 5).join(' / '))

          section(`5. 播放页解析（第 ${epNumber} 集）`)
          const episode = mod.pickEpisode(ordered[0].episodes, epNumber)
          if (!episode) {
            bad('没有可用剧集')
          } else {
            console.log(`    目标剧集：${episode.name} → ${episode.url}`)
            const playRes = await httpGet(episode.url, cookie)
            console.log(`    HTTP ${playRes.status}，${playRes.text.length} 字节`)
            if (playRes.status !== 200) {
              bad('播放页请求失败')
            } else {
              const playUrl = mod.extractPlayUrl(playRes.text)
              if (!playUrl) {
                bad('播放直链提取失败——playSource 结构或正则变了')
                for (const kw of ['playSource', '.m3u8', '.mp4']) {
                  console.log(`    「${kw}」位置：${playRes.text.indexOf(kw)}`)
                }
                const idx = playRes.text.indexOf('.m3u8')
                console.log(`    片段：${JSON.stringify(playRes.text.slice(Math.max(0, idx - 200), idx + 200))}`)
              } else if (!mod.isValidPlayUrl(playUrl)) {
                bad('提取到链接但 isValidPlayUrl 判为无效', playUrl)
              } else {
                ok('播放直链提取成功', playUrl.slice(0, 100) + (playUrl.length > 100 ? '…' : ''))
                // 直链要真的能拉到头，否则是死链
                try {
                  const head = await fetch(playUrl, { method: 'GET', signal: AbortSignal.timeout(20_000) })
                  const body = await head.text()
                  console.log(`    直链 HTTP ${head.status}，${body.length} 字节，首行：${JSON.stringify(body.split('\n')[0])}`)
                  if (head.status === 200 && body.trimStart().startsWith('#EXTM3U')) {
                    ok('直链是有效 m3u8 播放列表')
                  } else {
                    bad('直链返回异常', `HTTP ${head.status}，开头 ${JSON.stringify(body.slice(0, 120))}`)
                  }
                } catch (e) {
                  bad('直链拉取失败', String(e))
                }

                section('6. 一起看链接')
                const room = mod.buildWatchTogetherUrl(playUrl)
                if (room.includes(encodeURIComponent(playUrl))) ok('房间链接生成', room.slice(0, 100) + '…')
                else bad('房间链接里没有编码后的直链')
                const expiry = mod.describePlayUrlExpiry(playUrl)
                if (expiry) ok('时效提示', expiry)
                else console.log('    （这条直链没有 timestamp 参数，不报时效——正常）')
              }
            }
          }
        }
      }
    }
  }
}

section('7. 走插件自己的 createKkys 完整链路（与线上同一条代码路径）')
{
  let homeHits = 0
  const countingFetch = async (url, init) => {
    if (String(url) === BASE || String(url) === `${BASE}/`) homeHits += 1
    return fetch(url, init)
  }
  const kv = memoryKv()
  const config = {
    filterIrrelevant: true,
    maxResults: 8,
    watchTogetherBase: 'https://yqk.060908.xyz/watch.html',
    manualCookie: '',
  }
  const client = mod.createKkys({ kv, logger, config, fetch: countingFetch })
  const results = await client.search(keyword)
  if (results === null) bad('client.search 返回 null（凭证或网络问题）')
  else if (results.length === 0) bad('client.search 返回空数组')
  else ok('client.search', `${results.length} 条`)

  if (results && results.length > 0) {
    const detail = await client.detail(results[0].detailUrl)
    if (!detail) bad('client.detail 返回 null')
    else ok('client.detail', `${detail.title}，${detail.lines.length} 条线路`)

    if (detail && detail.lines.length > 0) {
      const ep = mod.pickEpisode(mod.orderLines(detail.lines)[0].episodes, 1)
      if (ep) {
        const url = await client.playUrl(ep.url)
        if (!mod.isValidPlayUrl(url)) bad('client.playUrl 没拿到有效直链')
        else ok('client.playUrl', url.slice(0, 80) + '…')
      }
    }
    // 关键：整条链路只应该请求少数几次首页
    console.log(`    首页请求次数：${homeHits}（一次事件内应远小于各步骤之和）`)
    if (homeHits <= 3) ok('凭证在同一次事件内复用有效', `${homeHits} 次`)
    else bad('首页请求次数偏多，缓存可能没生效', `${homeHits} 次`)
  }

  const st = await client.status()
  ok('client.status', `cookie=${st.cookieLength} 字符，t=${st.t ?? '(空)'}，首页=${st.homepage.kind}`)
}

section('8. 反爬凭证复用（第二次搜索不该再请求首页）')
{
  let homeHits = 0
  const countingFetch = async (url, init) => {
    if (String(url) === BASE || String(url) === `${BASE}/`) homeHits += 1
    return fetch(url, init)
  }
  const kv = memoryKv()
  const config = {
    filterIrrelevant: true,
    maxResults: 8,
    watchTogetherBase: 'https://yqk.060908.xyz/watch.html',
    manualCookie: '',
  }
  // 先跑一次把凭证写进「KV」
  const first = mod.createKkys({ kv, logger, config, fetch: countingFetch })
  await first.search(keyword)
  const afterFirst = homeHits
  // 新客户端 + 同一份 KV，模拟下一个事件
  const second = mod.createKkys({ kv, logger, config, fetch: countingFetch })
  await second.search(keyword)
  const afterSecond = homeHits - afterFirst
  console.log(`    第一次事件首页请求 ${afterFirst} 次，第二次事件 ${afterSecond} 次`)
  if (afterSecond === 0) ok('跨事件凭证复用生效（20 分钟内不再请求首页）')
  else bad('第二次事件仍请求了首页', `${afterSecond} 次`)
}

console.log(`\n${'='.repeat(50)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail > 0 ? 1 : 0)
