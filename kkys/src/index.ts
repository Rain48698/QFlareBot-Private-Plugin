/**
 * 可可影视 (kkys01.com) — 影片搜索 / 播放直链解析 / 一起看房间链接。
 *
 * 移植自同仓库的 kkys_py/kkys_cli.py，业务行为（反爬重破、线路↔剧集切片、
 * 播放链接正则、时效提示）与 CLI 对齐。两处结构性差异来自运行环境：
 *
 *   1. Worker 里没有 BeautifulSoup/DOM，页面解析全部是正则。正则对着真实页面
 *      写，样本固化在 src/kkys.test.ts 里。
 *   2. 反爬 PoW 用纯 JS 单块 SHA-1，不用 crypto.subtle：实测纯 JS 183 万 hash/s，
 *      WebCrypto 逐次 await 只有 6.4 万 hash/s（每次调用的开销吃掉了全部收益）。
 *      代价是这段循环吃 CPU（免费版 Worker 单次 10ms 不够），所以解出来的 Cookie
 *      存 KV 复用，只在真被反爬拦截时才重跑。
 */

import { button, definePlugin, keyboard } from '@qqbot/sdk'

// ---------------------------------------------------------------------------
// 站点常量
// ---------------------------------------------------------------------------

const BASE_URL = 'https://www.kkys01.com'
const DEFAULT_WATCH_TOGETHER_BASE = 'https://yqk.060908.xyz/watch.html'
/** 自动选线路时最多试几条线路 */
const MAX_LINE_TRIES = 5
/** 自动选线路时跳过的线路名关键词 */
const SKIP_LINE_KEYWORDS = ['4k']
/**
 * 播放直链由 CDN 签发，sign 与 timestamp 必须同时匹配，改/删任一参数都会 403，
 * 所以链接有时效。真实有效期长度由 CDN 决定，未确知时保持 null（只报签发时间）。
 */
const PLAY_URL_TTL_SECONDS: number | null = null
/** PoW 穷举上限：期望 65536 次命中，100 万次没命中就说明挑战格式变了 */
const POW_MAX_TRIES = 1_000_000
const CREDS_KEY = 'creds'
const CREDS_TTL_SECONDS = 12 * 3600
/** 凭证多久内认为还新鲜、不必再请求首页确认 */
const CREDS_FRESH_MS = 20 * 60 * 1000
const SESSION_TTL_SECONDS = 30 * 60
const HTTP_TIMEOUT_MS = 15_000
const HOMEPAGE_TIMEOUT_MS = 20_000
/** 剧集按键每页条数 */
const EPISODE_PAGE_SIZE = 12

/**
 * 刻意不写 accept-encoding：Worker 的 fetch 自己协商压缩（原生支持 br/zstd），
 * 手写反而可能拿到解不开的编码。也不要加 sec-* 这类浏览器指纹头，站点不看它。
 */
const HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface Config {
  filterIrrelevant: boolean
  maxResults: number
  watchTogetherBase: string
  manualCookie: string
}

export interface SearchResult {
  title: string
  year: string
  country: string
  genre: string
  actors: string
  desc: string
  detailUrl: string
  vodId: string
}

export interface Episode {
  name: string
  url: string
  vodId: string
  lineId: string
  episodeId: string
}

export interface PlayLine {
  id: string
  name: string
  sublabel: string
  episodes: Episode[]
}

export interface MovieDetail {
  title: string
  detailUrl: string
  lines: PlayLine[]
}

interface KvStore {
  getJSON<T = unknown>(key: string): Promise<T | null>
  put(key: string, value: string | object, options?: { ttl?: number }): Promise<void>
}

interface LoggerLike {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}

export interface KkysRuntime {
  kv: KvStore
  logger: LoggerLike
  config: Config
  fetch: typeof fetch
}

/** 处理器里用得到的那部分 ctx（结构化类型，测试里传替身也方便） */
interface PluginCtxLike {
  kv: KvStore
  logger: LoggerLike
  config: Config
}

interface HttpResult {
  /** -1 表示请求本身失败（网络异常），与「反爬拦截」「HTTP 错误」区分开 */
  status: number
  text: string
}

interface Creds {
  cookie: string
  t: string
  ts: number
}

/** 一次会话（选片 → 选线路 → 选集）的上下文，存 KV */
export interface SessionState {
  kw: string
  title: string
  detailUrl: string
  lines: { name: string; sub: string; n: number }[]
  /** 扁平剧集，每行 `lineId-epId\t名称`，按 DOM 顺序 —— 线路对应关系靠累计切片还原 */
  flat: string
  /** 选片阶段的候选结果 */
  results?: { t: string; u: string }[]
  playUrl?: string
  lineIdx?: number
  epIdx?: number
  ts: number
}

// ---------------------------------------------------------------------------
// HTML 解析（正则版，对照真实页面结构）
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    // &amp; 必须最后解，否则 &amp;lt; 会被解成 <
    .replace(/&amp;/g, '&')
}

/** 去掉标签与脚本/样式、压缩空白 —— 等价于 BeautifulSoup 的 get_text(strip=True) */
function stripTags(s: string): string {
  return decodeEntities(
    s
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function attrOf(attrs: string, name: string): string | null {
  const m =
    attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i')) ??
    attrs.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i'))
  return m?.[1] !== undefined ? decodeEntities(m[1]) : null
}

interface TagOpen {
  start: number
  end: number
  attrs: string
}

/**
 * 收集所有 class 里含指定「词」的开标签。
 * 必须按词比对：`search-result-item` 是 `search-result-item-main` 的前缀，
 * 直接匹配子串会把卡片内部的 div 也当成结果项。
 */
function findClassTags(html: string, tag: string, className: string): TagOpen[] {
  const re = new RegExp(`<${tag}\\b([^>]*)>`, 'gi')
  const out: TagOpen[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? ''
    const cls = attrOf(attrs, 'class')
    if (cls && cls.split(/\s+/).includes(className)) {
      out.push({ start: m.index, end: m.index + m[0].length, attrs })
    }
  }
  return out
}

/** 内容取到下一个同类开标签之前（站点里这些元素都是平铺的兄弟节点） */
function siblingBlock(html: string, opens: TagOpen[], i: number): string {
  return html.slice(opens[i]?.end ?? 0, opens[i + 1]?.start ?? html.length)
}

/**
 * 取某个 class 元素的内部 HTML。
 *
 * 不能用「开标签 + 懒惰匹配到第一个闭标签」的整段正则：那样 `.search-result-item-main`
 * 会把它内部先出现的 `<div class="title">` 一起吞掉，之后再从匹配结束位置继续扫，
 * 就再也找不到 title 了。这里只认开标签，内容取到第一个同名闭标签。
 */
function innerByClass(html: string, tag: string, className: string): string | null {
  const open = findClassTags(html, tag, className)[0]
  if (!open) return null
  const rest = html.slice(open.end)
  const closeIdx = rest.search(new RegExp(`</${tag}>`, 'i'))
  return closeIdx >= 0 ? rest.slice(0, closeIdx) : rest
}

function textByClass(html: string, tag: string, className: string): string {
  const inner = innerByClass(html, tag, className)
  return inner === null ? '' : stripTags(inner)
}

function absolutize(href: string): string {
  if (!href) return ''
  if (/^https?:\/\//i.test(href)) return href
  return href.startsWith('/') ? BASE_URL + href : `${BASE_URL}/${href}`
}

/** 首页里的搜索 token：`<input type="hidden" name="t" value="...">` */
export function parseTParam(html: string): string | null {
  const input = html.match(/<input[^>]*\bname\s*=\s*["']t["'][^>]*>/i)
  if (input) {
    const value = attrOf(input[0], 'value')
    if (value) return value
  }
  const m = html.match(/search\?t=([^"'&\s]+)/)
  if (m?.[1]) {
    try {
      return decodeEntities(decodeURIComponent(m[1]))
    } catch {
      return decodeEntities(m[1])
    }
  }
  return null
}

export function parseSearchResults(html: string): SearchResult[] {
  const opens = findClassTags(html, 'a', 'search-result-item')
  const results: SearchResult[] = []
  for (let i = 0; i < opens.length; i++) {
    const open = opens[i]
    if (!open) continue
    const href = attrOf(open.attrs, 'href')
    if (!href) continue
    const block = siblingBlock(html, opens, i)
    const tagsInner = innerByClass(block, 'div', 'tags')
    const tags = tagsInner
      ? [...tagsInner.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)].map((m) => stripTags(m[1] ?? ''))
      : []
    const detailUrl = absolutize(href)
    results.push({
      title: textByClass(block, 'div', 'title'),
      year: tags[0] ?? '',
      country: tags[1] ?? '',
      genre: textByClass(block, 'div', 'search-result-item-header'),
      actors: textByClass(block, 'div', 'actors'),
      desc: textByClass(block, 'div', 'desc'),
      detailUrl,
      vodId: /\/detail\/(\d+)\.html/.exec(detailUrl)?.[1] ?? '',
    })
  }
  return results
}

/**
 * 详情页标题。装饰行 `𝕜𝕜𝕪𝕤𝟘𝟙.𝕔𝕠𝕞`（数学字母符号 U+1D400–U+1D7FF）不含汉字，
 * 取「含汉字的最长一行」就能稳定挑出真标题。
 */
export function parseDetailTitle(html: string): string {
  const inner = innerByClass(html, 'div', 'detail-title')
  if (inner === null) return ''
  const lines = inner
    .split(/<\/(?:strong|span|div|a|h1|p)>/i)
    .map((s) => stripTags(s))
    .filter((s) => s.length > 0)
  let best = ''
  for (const line of lines) {
    if (/[\u4e00-\u9fff]/.test(line) && line.length > best.length) best = line
  }
  if (best) return best
  const raw = stripTags(inner)
  return raw.replace(/[^\w\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef·\-—]/g, '').trim() || (lines[0] ?? '')
}

/**
 * 详情页的线路与剧集。
 *
 * 详情页把所有线路的剧集拼在一个扁平的 `.episode-list` 里，没有分线路容器，
 * `.source-item` 上也没有关联属性，所以线路↔剧集只能按 `.source-item-num`
 * 的累计偏移切片还原（一条线路会被多个 source-item 复用，按位置对齐必然错位）。
 * 站点改版导致声明集数与实际剧集数对不上时，退化为按 lineId 分组。
 * 详见 kkys_py/README.md 6.5。
 */
export function parseDetail(html: string, detailUrl: string): MovieDetail {
  const srcOpens = findClassTags(html, 'a', 'source-item')
  const srcInfos: { name: string; sublabel: string; declared: number }[] = []
  for (let i = 0; i < srcOpens.length; i++) {
    const block = siblingBlock(html, srcOpens, i)
    const numText = textByClass(block, 'i', 'source-item-num')
    srcInfos.push({
      name: textByClass(block, 'span', 'source-item-label'),
      sublabel: textByClass(block, 'span', 'source-item-sublabel'),
      declared: Number(/\d+/.exec(numText)?.[0] ?? 0) || 0,
    })
  }

  const epOpens = findClassTags(html, 'a', 'episode-item')
  const flat: Episode[] = []
  for (let i = 0; i < epOpens.length; i++) {
    const href = attrOf(epOpens[i]?.attrs ?? '', 'href') ?? ''
    const m = /^\/play\/(\d+)-(\d+)-(\d+)\.html$/.exec(href)
    if (!m) continue
    const block = siblingBlock(html, epOpens, i)
    const name = stripTags(block.split(/<\/a>/i)[0] ?? '')
    if (!name) continue
    flat.push({ name, url: absolutize(href), vodId: m[1] ?? '', lineId: m[2] ?? '', episodeId: m[3] ?? '' })
  }

  const lines: PlayLine[] = []
  const declaredTotal = srcInfos.reduce((sum, info) => sum + info.declared, 0)
  if (srcInfos.length > 0 && declaredTotal === flat.length) {
    let offset = 0
    for (const info of srcInfos) {
      const seg = flat.slice(offset, offset + info.declared)
      offset += info.declared
      // line_id 取自切片内首个剧集的链接，比按位置猜测可靠
      lines.push({ id: seg[0]?.lineId ?? '', name: info.name, sublabel: info.sublabel, episodes: seg })
    }
  } else if (flat.length > 0) {
    const byLine = new Map<string, Episode[]>()
    for (const ep of flat) {
      const bucket = byLine.get(ep.lineId)
      if (bucket) bucket.push(ep)
      else byLine.set(ep.lineId, [ep])
    }
    for (const [lineId, eps] of byLine) {
      lines.push({ id: lineId, name: `线路${lineId}`, sublabel: '', episodes: eps })
    }
  }

  return { title: parseDetailTitle(html), detailUrl, lines }
}

/** 播放页的 4 种链接正则，前两条匹配 playSource 对象，后两条兜底裸链接 */
const PLAY_URL_PATTERNS = [
  /playSource\s*=\s*\{[^}]*?src:\s*"((?:https?:)?\/\/[^"]+?\.m3u8[^"]*)"/,
  /playSource\s*=\s*\{[^}]*?src:\s*"((?:https?:)?\/\/[^"]+?\.mp4[^"]*)"/,
  /"((?:https?:)?\/\/[^"\s<>]+?\.m3u8[^"\s<>]*)"/,
  /"((?:https?:)?\/\/[^"\s<>]+?\.mp4[^"\s<>]*)"/,
]

export function extractPlayUrl(html: string): string | null {
  for (const pattern of PLAY_URL_PATTERNS) {
    const m = pattern.exec(html)
    if (m?.[1]) return m[1].replace(/\\+$/, '')
  }
  return null
}

/**
 * 按 URL 的 path 扩展名判断是否为可直接播放的媒体链接。
 * 不能只看字符串后缀：真实链接带查询串（.../index.m3u8?appId=..&sign=..），
 * 查询串顺序、大小写变化都会让朴素的后缀匹配把好线路误判成无效。
 */
export function isValidPlayUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const path = new URL(url, BASE_URL).pathname.toLowerCase()
    return path.endsWith('.m3u8') || path.endsWith('.mp4')
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 反爬：cdndefend 挑战（SHA-1 部分原像 PoW）
// ---------------------------------------------------------------------------

export interface CdndefendChallenge {
  c: string
  n1: number
}

/**
 * 解析挑战页：取混淆数组、模拟 IIFE 里的数组旋转，还原出 c 与检查偏移 n1。
 * 站点改混淆格式时这里会失配并返回 null —— 报「破解失败」就是信号，要重新分析挑战页。
 */
export function parseCdndefendChallenge(html: string): CdndefendChallenge | null {
  const m = html.match(/a0_0x2a54\s*=\s*\[([^\]]+)\]/)
  if (!m?.[1]) return null
  const elements = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1] ?? '')
  if (elements.length < 3) return null
  const mPair = html.match(/a0_0x2a54\s*,\s*(0x[0-9a-fA-F]+)\)/)
  if (!mPair?.[1]) return null
  const shuffleCount = parseInt(mPair[1], 16) + 1
  const arr = elements.slice()
  const rotations = (shuffleCount - 1) % arr.length
  for (let i = 0; i < rotations; i++) arr.push(arr.shift() as string)
  const c = arr[2]
  if (!c) return null
  const n1 = parseInt(c[0] ?? '', 16)
  if (!Number.isFinite(n1)) return null
  return { c, n1 }
}

const SHA1_K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6]

/**
 * 在 [0, limit) 里找 i，使 SHA1(c + String(i)) 的第 n1 字节为 0xB0、第 n1+1 字节为 0x0B。
 *
 * 手写单块 SHA-1：消息是 40 位 hex 的 c 加十进制 i，长度 40..47 字节，永远落在
 * 一个 64 字节块里，所以没有多块逻辑；W[0..9] 是 c 的 10 个 word，跨 i 恒定，
 * 循环外只算一次。命中后只算需要的那个 digest word（前 256 分之 255 在第一个
 * 字节就被排除）。
 */
export function solveCdndefend(c: string, n1: number, limit: number): number {
  const W = new Int32Array(80)
  for (let k = 0; k < 10; k++) {
    const o = k * 4
    W[k] = (c.charCodeAt(o) << 24) | (c.charCodeAt(o + 1) << 16) | (c.charCodeAt(o + 2) << 8) | c.charCodeAt(o + 3)
  }
  const wordIdx = n1 >> 2
  const shift = 24 - 8 * (n1 & 3)

  for (let i = 0; i < limit; i++) {
    const s = '' + i
    const len = 40 + s.length
    W[10] = W[11] = W[12] = W[13] = W[14] = 0
    W[15] = len << 3
    for (let j = 0; j < s.length; j++) {
      const b = 40 + j
      W[b >> 2] = (W[b >> 2] as number) | (s.charCodeAt(j) << (24 - 8 * (b & 3)))
    }
    W[len >> 2] = (W[len >> 2] as number) | (0x80 << (24 - 8 * (len & 3)))

    for (let t = 16; t < 80; t++) {
      const v = W[t - 3]! ^ W[t - 8]! ^ W[t - 14]! ^ W[t - 16]!
      W[t] = (v << 1) | (v >>> 31)
    }

    let a = 0x67452301
    let b = 0xefcdab89
    let cc = 0x98badcfe
    let d = 0x10325476
    let e = 0xc3d2e1f0
    for (let t = 0; t < 80; t++) {
      const f =
        t < 20 ? (b & cc) | (~b & d) : t < 40 ? b ^ cc ^ d : t < 60 ? (b & cc) | (b & d) | (cc & d) : b ^ cc ^ d
      const tmp = ((((a << 5) | (a >>> 27)) + f + e + SHA1_K[(t / 20) | 0]! + W[t]!) | 0) >>> 0
      e = d
      d = cc
      cc = ((b << 30) | (b >>> 2)) >>> 0
      b = a
      a = tmp
    }

    const word = (
      wordIdx === 0
        ? 0x67452301 + a
        : wordIdx === 1
          ? 0xefcdab89 + b
          : wordIdx === 2
            ? 0x98badcfe + cc
            : wordIdx === 3
              ? 0x10325476 + d
              : 0xc3d2e1f0 + e
    ) >>> 0
    if (((word >>> shift) & 0xff) !== 0xb0) continue

    let second: number
    if ((n1 & 3) === 3) {
      const nextWord = (
        wordIdx === 0
          ? 0xefcdab89 + b
          : wordIdx === 1
            ? 0x98badcfe + cc
            : wordIdx === 2
              ? 0x10325476 + d
              : 0xc3d2e1f0 + e
      ) >>> 0
      second = (nextWord >>> 24) & 0xff
    } else {
      second = (word >>> (shift - 8)) & 0xff
    }
    if (second === 0x0b) return i
  }
  return -1
}

/** 850 + 挑战页都算命中反爬 */
export function isChallenge(status: number, text: string): boolean {
  return status === 850 || text.slice(0, 3000).toLowerCase().includes('cdndefend')
}

// ---------------------------------------------------------------------------
// 链接工具
// ---------------------------------------------------------------------------

export function buildWatchTogetherUrl(videoUrl: string, base = DEFAULT_WATCH_TOGETHER_BASE): string {
  return `${base}?url=${encodeURIComponent(videoUrl)}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Worker 是 UTC，观众在国内，统一按 UTC+8 显示 */
function formatShanghai(ms: number): string {
  const d = new Date(ms + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(
    d.getUTCMinutes(),
  )}:${pad2(d.getUTCSeconds())}`
}

/**
 * 解析播放直链里的时效签名，返回给用户看的提示。
 * 真实有效期长度未确知时只报签发时间，不编造失效时刻；签发超过 30 分钟的额外
 * 提示可能来自播放页缓存。
 */
export function describePlayUrlExpiry(videoUrl: string): string | null {
  let raw: string | null = null
  try {
    raw = new URL(videoUrl, BASE_URL).searchParams.get('timestamp')
  } catch {
    return null
  }
  if (!raw || !/^\d+$/.test(raw)) return null
  const issuedMs = Number(raw) * 1000
  let text = `链接带时效签名，签发于 ${formatShanghai(issuedMs)}`
  if (PLAY_URL_TTL_SECONDS) {
    text += `，约 ${formatShanghai(issuedMs + PLAY_URL_TTL_SECONDS * 1000)} 失效`
  } else {
    text += '，过期后需重新解析'
  }
  const ageMinutes = Math.floor((Date.now() - issuedMs) / 60000)
  if (ageMinutes > 30) text += `（注意：这条链接已签发 ${ageMinutes} 分钟，来自页面缓存）`
  return text
}

// ---------------------------------------------------------------------------
// 标题相关性：站点是前缀/子串模糊匹配，搜不到时会混进完全无关的条目
// ---------------------------------------------------------------------------

function normalizeTitle(s: string): string {
  return s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
}

function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0
  let prev = new Array<number>(b.length + 1).fill(0)
  let best = 0
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        const v = (prev[j - 1] ?? 0) + 1
        cur[j] = v
        if (v > best) best = v
      }
    }
    prev = cur
  }
  return best
}

/**
 * 判定尽量宽松，避免误杀（同系列、简称、带季数后缀）。
 * 判定细节见 kkys_py/README.md 6.6。
 */
export function isRelevantTitle(title: string, keyword: string): boolean {
  const t = normalizeTitle(title)
  const k = normalizeTitle(keyword)
  if (!t || !k) return true
  if (t.includes(k) || k.includes(t)) return true
  return longestCommonSubstring(k, t) >= Math.max(2, Math.min(k.length, t.length) / 2)
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export function createKkys(runtime: KkysRuntime) {
  const { kv, logger, config, fetch: doFetch } = runtime

  async function httpGet(url: string, cookie: string | null, timeoutMs = HTTP_TIMEOUT_MS): Promise<HttpResult> {
    const headers: Record<string, string> = { ...HEADERS }
    if (cookie) headers.cookie = cookie
    try {
      const res = await doFetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      return { status: res.status, text }
    } catch (e) {
      logger.error('请求失败（网络问题，不是反爬也不是 Cookie 失效）', { url, error: String(e) })
      return { status: -1, text: '' }
    }
  }

  async function loadCreds(): Promise<Creds | null> {
    try {
      return await kv.getJSON<Creds>(CREDS_KEY)
    } catch (e) {
      logger.warn('读取凭证失败', { error: String(e) })
      return null
    }
  }

  async function saveCreds(creds: Creds): Promise<void> {
    try {
      await kv.put(CREDS_KEY, creds, { ttl: CREDS_TTL_SECONDS })
    } catch (e) {
      logger.warn('保存凭证失败', { error: String(e) })
    }
  }

  /** 不带 Cookie 请求首页触发 850，破解 PoW，返回可用的 Cookie 值 */
  async function solveCookie(): Promise<string | null> {
    const res = await httpGet(BASE_URL, null, HOMEPAGE_TIMEOUT_MS)
    if (res.status === -1) return null
    if (res.status === 200) return null
    if (!isChallenge(res.status, res.text)) {
      logger.error('首页返回意外状态码，未触发反爬挑战', { status: res.status })
      return null
    }
    const parsed = parseCdndefendChallenge(res.text)
    if (!parsed) {
      logger.error('反爬挑战页格式变了（正则失配），需要重新分析挑战页 JS')
      return null
    }
    const started = Date.now()
    const i = solveCdndefend(parsed.c, parsed.n1, POW_MAX_TRIES)
    if (i < 0) {
      logger.error('PoW 在穷举上限内未命中', { limit: POW_MAX_TRIES })
      return null
    }
    logger.info('反爬挑战已破解', { tries: i + 1, ms: Date.now() - started })
    return `cdndefend_js_cookie=${parsed.c}${i}`
  }

  /**
   * 确保 Cookie 与 t 参数就绪。只发一次首页请求：同一个响应既用来判断是否需要
   * 挑战，也用来提取 t 参数。凭证新鲜时直接返回缓存，不发请求。
   */
  async function ensureReady(force = false): Promise<Creds | null> {
    const cached = await loadCreds()
    if (!force && cached && cached.t && Date.now() - cached.ts < CREDS_FRESH_MS) return cached

    let cookie = config.manualCookie.trim() || cached?.cookie || ''
    let res = await httpGet(BASE_URL, cookie || null, HOMEPAGE_TIMEOUT_MS)
    if (res.status === -1) return null

    if (isChallenge(res.status, res.text)) {
      if (config.manualCookie.trim()) {
        logger.error('面板里配置的手动 Cookie 也被反爬拦截了，请换一条新的')
        return null
      }
      const solved = await solveCookie()
      if (!solved) return null
      cookie = solved
      res = await httpGet(BASE_URL, cookie, HOMEPAGE_TIMEOUT_MS)
      if (res.status === -1 || isChallenge(res.status, res.text)) {
        logger.error('破解后仍被反爬拦截')
        return null
      }
    } else if (res.status !== 200) {
      logger.error('首页返回非 200（不是反爬问题，可能是服务端故障）', { status: res.status })
      return null
    }

    // t 参数与 Cookie 同一会话，破解后必须重新提取
    const t = parseTParam(res.text) ?? cached?.t ?? null
    if (!t) {
      logger.error('无法从首页提取 t 参数')
      return null
    }
    const creds: Creds = { cookie, t, ts: Date.now() }
    await saveCreds(creds)
    return creds
  }

  /**
   * 请求业务页面；命中反爬时自动重新破解并重试一次。
   * 新增请求入口一律走这里，别直接用 httpGet —— 否则反爬失败会被伪装成业务失败。
   */
  async function getProtected(url: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<HttpResult> {
    const creds = await ensureReady()
    if (!creds) return { status: -1, text: '' }
    let res = await httpGet(url, creds.cookie || null, timeoutMs)
    if (res.status === -1 || !isChallenge(res.status, res.text)) return res

    logger.info('命中反爬保护，重新破解后重试', { url })
    const fresh = await ensureReady(true)
    if (!fresh) return res
    res = await httpGet(url, fresh.cookie || null, timeoutMs)
    return res
  }

  function searchUrl(t: string, keyword: string): string {
    return `${BASE_URL}/search?t=${encodeURIComponent(t)}&k=${encodeURIComponent(keyword)}`
  }

  /**
   * 搜索。返回 null 表示请求失败（网络/反爬/HTTP 错误），[] 表示确实没有结果。
   * 结果为空时强制重取一次 t 参数再试：t 会单独过期，此时站点返回 200 + 空列表，
   * 光看状态码分不出来（见 kkys_py/README.md 6.1）。
   */
  async function search(keyword: string, filterIrrelevant = config.filterIrrelevant): Promise<SearchResult[] | null> {
    const creds = await ensureReady()
    if (!creds) return null
    let res = await getProtected(searchUrl(creds.t, keyword))
    if (res.status === -1) return null
    if (isChallenge(res.status, res.text)) {
      logger.error('反爬校验未通过，搜索失败')
      return null
    }
    if (res.status !== 200) {
      logger.error('搜索请求失败', { status: res.status })
      return null
    }

    let results = parseSearchResults(res.text)
    if (results.length === 0) {
      const fresh = await ensureReady(true)
      if (fresh) {
        res = await getProtected(searchUrl(fresh.t, keyword))
        if (res.status === 200 && !isChallenge(res.status, res.text)) results = parseSearchResults(res.text)
      }
    }
    return filterIrrelevant ? results.filter((r) => isRelevantTitle(r.title, keyword)) : results
  }

  async function detail(detailUrl: string): Promise<MovieDetail | null> {
    const res = await getProtected(detailUrl, HOMEPAGE_TIMEOUT_MS)
    if (res.status === -1) return null
    if (isChallenge(res.status, res.text)) {
      logger.error('反爬校验未通过，无法解析详情页')
      return null
    }
    if (res.status !== 200) {
      logger.error('详情页返回非 200', { status: res.status })
      return null
    }
    return parseDetail(res.text, detailUrl)
  }

  async function playUrl(episodeUrl: string): Promise<string | null> {
    const res = await getProtected(episodeUrl)
    if (res.status === -1) return null
    if (isChallenge(res.status, res.text)) {
      logger.error('反爬校验未通过，无法获取播放链接')
      return null
    }
    if (res.status !== 200) {
      logger.error('播放页返回非 200', { status: res.status })
      return null
    }
    return extractPlayUrl(res.text)
  }

  /** 首页连通性 + 凭证状态，给 /看剧 状态 用 */
  async function status(): Promise<{
    cookieLength: number
    manualCookie: boolean
    t: string | null
    fresh: boolean
    homepage: { status: number; kind: 'ok' | 'challenge' | 'http-error' | 'network-error' }
  }> {
    const creds = await loadCreds()
    const cookie = config.manualCookie.trim() || creds?.cookie || ''
    const res = await httpGet(BASE_URL, cookie || null, HOMEPAGE_TIMEOUT_MS)
    let kind: 'ok' | 'challenge' | 'http-error' | 'network-error'
    if (res.status === -1) kind = 'network-error'
    else if (isChallenge(res.status, res.text)) kind = 'challenge'
    else if (res.status === 200) kind = 'ok'
    else kind = 'http-error'
    return {
      cookieLength: cookie.length,
      manualCookie: config.manualCookie.trim().length > 0,
      t: creds?.t ?? null,
      fresh: creds ? Date.now() - creds.ts < CREDS_FRESH_MS : false,
      homepage: { status: res.status, kind },
    }
  }

  return { httpGet, ensureReady, getProtected, search, detail, playUrl, status, solveCookie }
}

export type KkysClient = ReturnType<typeof createKkys>

// ---------------------------------------------------------------------------
// 选线路 / 选集
// ---------------------------------------------------------------------------

export function shouldSkipLine(lineName: string): boolean {
  const lower = lineName.toLowerCase()
  return SKIP_LINE_KEYWORDS.some((kw) => lower.includes(kw))
}

/** 优先非 4K 线路，其余仍按页面顺序 */
export function orderLines(lines: PlayLine[]): PlayLine[] {
  const usable = lines.filter((l) => l.episodes.length > 0)
  const preferred = usable.filter((l) => !shouldSkipLine(l.name))
  const skipped = usable.filter((l) => shouldSkipLine(l.name))
  return [...preferred, ...skipped]
}

/** 按集数选集：先精确匹配剧集名里的数字，再退回按序号取 */
export function pickEpisode(episodes: Episode[], epNumber: number): Episode | null {
  if (episodes.length === 0) return null
  if (epNumber <= 0) return episodes[0] ?? null
  for (const ep of episodes) {
    const digits = ep.name.replace(/\D/g, '')
    if (digits && Number(digits) === epNumber) return ep
  }
  return episodes[epNumber - 1] ?? null
}

// ---------------------------------------------------------------------------
// 会话状态（KV）
// ---------------------------------------------------------------------------

export function serializeFlat(episodes: Episode[]): string {
  return episodes.map((ep) => `${ep.lineId}-${ep.episodeId}\t${ep.name}`).join('\n')
}

export function deserializeFlat(flat: string, vodId: string): Episode[] {
  const out: Episode[] = []
  for (const row of flat.split('\n')) {
    if (!row) continue
    const tab = row.indexOf('\t')
    const ids = tab >= 0 ? row.slice(0, tab) : row
    const name = tab >= 0 ? row.slice(tab + 1) : ''
    const dash = ids.indexOf('-')
    if (dash <= 0) continue
    const lineId = ids.slice(0, dash)
    const episodeId = ids.slice(dash + 1)
    out.push({ name, url: `${BASE_URL}/play/${vodId}-${lineId}-${episodeId}.html`, vodId, lineId, episodeId })
  }
  return out
}

/** 按 source-item-num 的累计偏移把扁平剧集切回各线路 */
export function sliceLines(lines: { name: string; sub: string; n: number }[], flat: Episode[]): PlayLine[] {
  const declaredTotal = lines.reduce((sum, l) => sum + l.n, 0)
  if (lines.length > 0 && declaredTotal === flat.length) {
    const out: PlayLine[] = []
    let offset = 0
    for (const info of lines) {
      const seg = flat.slice(offset, offset + info.n)
      offset += info.n
      out.push({ id: seg[0]?.lineId ?? '', name: info.name, sublabel: info.sub, episodes: seg })
    }
    return out
  }
  const byLine = new Map<string, Episode[]>()
  for (const ep of flat) {
    const bucket = byLine.get(ep.lineId)
    if (bucket) bucket.push(ep)
    else byLine.set(ep.lineId, [ep])
  }
  return [...byLine].map(([lineId, eps]) => ({ id: lineId, name: `线路${lineId}`, sublabel: '', episodes: eps }))
}

export function newSessionId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return [...bytes]
    .map((b) => b.toString(36))
    .join('')
    .slice(0, 8)
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

const USAGE = [
  '🍿 可可影视',
  '/看剧 <片名> — 搜索并列出结果，点按钮选片、选线路、选集',
  '/看剧 <片名> <集数> — 直接给播放直链（例：/看剧 斗罗大陆 120）',
  '/一起看 <视频直链> — 生成一起看房间链接',
  '/看剧 状态 · /看剧 刷新 — 反爬凭证（仅管理员）',
].join('\n')

function truncateLabel(s: string, max = 10): string {
  return s.length > max ? s.slice(0, max) : s
}

function lineLabel(name: string, sublabel: string): string {
  return truncateLabel(sublabel ? `${name}·${sublabel}` : name)
}

/** 播放结果消息：直链 + 时效提示 + 一起看房间链接 */
function buildPlayMessage(options: {
  title: string
  episodeName: string
  lineName: string
  lineSublabel: string
  playUrl: string
  watchTogetherBase: string
}): string {
  const lineText = options.lineSublabel ? `${options.lineName}（${options.lineSublabel}）` : options.lineName
  const parts = [
    `🎬 ${options.title} · ${options.episodeName}`,
    `📺 ${lineText}`,
    '',
    '🔗 直链：',
    options.playUrl,
    '',
    '👥 一起看（发给好友同步观看）：',
    buildWatchTogetherUrl(options.playUrl, options.watchTogetherBase),
  ]
  const expiry = describePlayUrlExpiry(options.playUrl)
  if (expiry) parts.push('', `⏳ ${expiry}`)
  return parts.join('\n')
}

function playKeyboard(sid: string) {
  return keyboard([
    [
      button.callback('最新一集', `latest:${sid}`, { id: 'latest' }),
      button.callback('换线路', `lines:${sid}`, { id: 'lines' }),
      button.callback('一起看', `yqt:${sid}`, { id: 'yqt' }),
    ],
  ])
}

/**
 * 搜索结果列表：列出前 maxResults 条并给一排数字按键，选片走 pick 按键。
 * 缓存进 KV（30 分钟），按键只带一个短 sid，不把结果塞进按键数据里。
 */
async function buildSearchListReply(ctx: PluginCtxLike, keyword: string, results: SearchResult[]) {
  const max = Math.min(results.length, Math.max(1, Math.min(15, ctx.config.maxResults)))
  const shown = results.slice(0, max)
  const sid = newSessionId()
  const state: SessionState = {
    kw: keyword,
    title: '',
    detailUrl: '',
    lines: [],
    flat: '',
    results: shown.map((r) => ({ t: r.title, u: r.detailUrl })),
    ts: Date.now(),
  }
  try {
    await ctx.kv.put(`k:${sid}`, state, { ttl: SESSION_TTL_SECONDS })
  } catch (e) {
    ctx.logger.warn('搜索结果缓存失败，按键将不可用', { error: String(e) })
  }

  const list = shown
    .map((r, i) => {
      const tags = [r.year, r.country, r.genre].filter(Boolean).join(' · ')
      return `${i + 1}. ${r.title}${tags ? `\n    ${tags}` : ''}`
    })
    .join('\n')
  const note = results.length > max ? `\n\n（共 ${results.length} 条，只列了前 ${max} 条，可以换个更准的片名）` : ''
  const rows: ReturnType<typeof button.callback>[][] = []
  for (let i = 0; i < shown.length; i += 4) {
    rows.push(
      shown.slice(i, i + 4).map((_, j) => button.callback(String(i + j + 1), `pick:${sid}:${i + j}`, { id: 'pick' })),
    )
  }
  return {
    text: `🔍「${keyword}」找到 ${results.length} 条：\n${list}${note}\n\n👉 点数字选片，或直接 /看剧 ${keyword} <集数>`,
    keyboard: keyboard(rows),
    quote: true,
  }
}

async function loadSession(ctx: PluginCtxLike, sid: string | undefined): Promise<SessionState | null> {
  if (!sid) return null
  try {
    return await ctx.kv.getJSON<SessionState>(`k:${sid}`)
  } catch (e) {
    ctx.logger.warn('读取会话失败', { error: String(e) })
    return null
  }
}

function vodIdOf(detailUrl: string): string {
  return /\/detail\/(\d+)\.html/.exec(detailUrl)?.[1] ?? ''
}

function sessionLines(state: SessionState): PlayLine[] {
  return sliceLines(state.lines, deserializeFlat(state.flat, vodIdOf(state.detailUrl)))
}

/** 剧集分页：每页最多 12 集，默认展示最后一页（最新几集） */
function episodePageReply(state: SessionState, sid: string, lineIdx: number, line: PlayLine, page: number) {
  const pageCount = Math.max(1, Math.ceil(line.episodes.length / EPISODE_PAGE_SIZE))
  const pageIdx = Math.min(Math.max(0, Number.isFinite(page) ? page : pageCount - 1), pageCount - 1)
  const start = pageIdx * EPISODE_PAGE_SIZE
  const slice = line.episodes.slice(start, start + EPISODE_PAGE_SIZE)

  const rows: ReturnType<typeof button.callback>[][] = []
  for (let i = 0; i < slice.length; i += 4) {
    rows.push(
      slice
        .slice(i, i + 4)
        .map((ep, j) => button.callback(truncateLabel(ep.name), `ep:${sid}:${lineIdx}:${start + i + j}`, { id: 'ep' })),
    )
  }
  const nav: ReturnType<typeof button.callback>[] = []
  if (pageIdx > 0) nav.push(button.callback('上一页', `page:${sid}:${lineIdx}:${pageIdx - 1}`, { id: 'page' }))
  if (pageIdx < pageCount - 1) {
    nav.push(button.callback('下一页', `page:${sid}:${lineIdx}:${pageIdx + 1}`, { id: 'page' }))
  }
  if (nav.length > 0) rows.push(nav)

  const label = line.sublabel ? `${line.name}（${line.sublabel}）` : line.name
  const pageInfo =
    pageCount > 1
      ? `\n（第 ${start + 1}-${Math.min(start + EPISODE_PAGE_SIZE, line.episodes.length)} 集，第 ${pageIdx + 1}/${pageCount} 页）`
      : ''
  return {
    text: `${state.title} · ${label} · 共 ${line.episodes.length} 集${pageInfo}\n\n👉 点集数取直链`,
    keyboard: keyboard(rows),
    quote: true,
  }
}

export default definePlugin<Config>({
  name: 'kkys',
  apiVersion: 1,
  displayName: '可可影视',
  description: '搜索 kkys01.com 影片、解析播放直链并生成一起看房间链接',
  permissions: ['kv', 'net'],

  configSchema: {
    type: 'object',
    properties: {
      filterIrrelevant: {
        type: 'boolean',
        title: '过滤无关搜索结果',
        default: true,
        description: '站点是模糊匹配，搜不到时会返回无关影片。开启后按标题相似度剔除（判定宽松，避免误杀）',
      },
      maxResults: {
        type: 'integer',
        title: '搜索结果展示条数',
        default: 8,
        minimum: 1,
        maximum: 15,
      },
      watchTogetherBase: {
        type: 'string',
        title: '一起看地址',
        default: DEFAULT_WATCH_TOGETHER_BASE,
      },
      manualCookie: {
        type: 'string',
        title: '手动 Cookie（应急）',
        default: '',
        writeOnly: true,
        description:
          '留空即自动破解反爬。站点改了挑战页格式、自动破解失效时，从浏览器复制 `cdndefend_js_cookie=...` 填进来应急',
      },
    },
  },
  defaultConfig: {
    filterIrrelevant: true,
    maxResults: 8,
    watchTogetherBase: DEFAULT_WATCH_TOGETHER_BASE,
    manualCookie: '',
  },

  commands: {
    // 不带集数：搜索并列出结果（点按钮选片）；带集数：一步到位给直链
    看剧: {
      description: '搜索影片并解析播放直链',
      usage: '/看剧 <片名> [集数]',
      aliases: ['kkys', '可可影视'],
      async handler({ ctx, argText }) {
        const client = createKkys({ kv: ctx.kv, logger: ctx.logger, config: ctx.config, fetch })
        const text = argText.trim()
        if (!text) return USAGE

        // 末尾以空白分隔的纯数字视为集数（"斗罗大陆2" 这种贴着的数字不算，仍是片名）
        const m = text.match(/^(.*\S)\s+(\d{1,5})$/)
        let keyword = text
        let epNumber = 1
        let explicitEpisode = false
        if (m?.[1] && m[2]) {
          keyword = m[1]
          epNumber = Number(m[2])
          explicitEpisode = true
        }

        let results = await client.search(keyword)
        if (results === null) return '❌ 搜索失败：反爬校验或网络请求没通过，稍后再试（管理员可发 /看剧 刷新）'
        if (results.length === 0 && explicitEpisode) {
          // 也可能片名本身就带空格数字（"甄嬛传 2"），退回按整串当片名搜，然后列结果
          results = await client.search(text)
          if (results && results.length > 0) {
            keyword = text
            epNumber = 1
            explicitEpisode = false
          }
        }
        if (!results || results.length === 0) {
          return `😞 没搜到「${keyword}」。站点是模糊匹配，换个片名试试`
        }

        if (!explicitEpisode) return buildSearchListReply(ctx, keyword, results)

        const picked = results[0]
        if (!picked) return `😞 没搜到「${keyword}」`
        const detail = await client.detail(picked.detailUrl)
        if (!detail) return '❌ 详情页解析失败：反爬校验或网络请求没通过'
        const ordered = orderLines(detail.lines)
        if (ordered.length === 0) return `😞「${detail.title || picked.title}」暂无可用线路`

        let resolved: { line: PlayLine; episode: Episode; playUrl: string } | null = null
        let tried = 0
        for (const line of ordered) {
          if (tried >= MAX_LINE_TRIES) break
          tried += 1
          const episode = pickEpisode(line.episodes, epNumber)
          if (!episode) continue
          const url = await client.playUrl(episode.url)
          if (isValidPlayUrl(url)) {
            resolved = { line, episode, playUrl: url as string }
            break
          }
        }
        if (!resolved) {
          return `❌「${detail.title || picked.title}」的第 ${epNumber} 集没取到播放链接，可能该集还没上线，换个集数或线路试试`
        }

        // 存一份会话，给下面的按键用（换线路 / 最新一集 / 一起看）
        const sid = newSessionId()
        const state: SessionState = {
          kw: keyword,
          title: detail.title || picked.title,
          detailUrl: picked.detailUrl,
          lines: ordered.map((l) => ({ name: l.name, sub: l.sublabel, n: l.episodes.length })),
          flat: serializeFlat(ordered.flatMap((l) => l.episodes)),
          playUrl: resolved.playUrl,
          lineIdx: ordered.indexOf(resolved.line),
          epIdx: resolved.line.episodes.indexOf(resolved.episode),
          ts: Date.now(),
        }
        try {
          await ctx.kv.put(`k:${sid}`, state, { ttl: SESSION_TTL_SECONDS })
        } catch (e) {
          ctx.logger.warn('会话状态保存失败，按键将不可用', { error: String(e) })
        }

        const more = results.length > 1 ? `\n\n💡 另有 ${results.length - 1} 条同名结果：/看剧 ${keyword}` : ''
        return {
          text:
            buildPlayMessage({
              title: state.title,
              episodeName: resolved.episode.name,
              lineName: resolved.line.name,
              lineSublabel: resolved.line.sublabel,
              playUrl: resolved.playUrl,
              watchTogetherBase: ctx.config.watchTogetherBase,
            }) + more,
          keyboard: playKeyboard(sid),
          quote: true,
        }
      },
    },

    '看剧 状态': {
      description: '查看反爬凭证状态',
      permission: 'bot_admin',
      async handler({ ctx }) {
        const client = createKkys({ kv: ctx.kv, logger: ctx.logger, config: ctx.config, fetch })
        const st = await client.status()
        const home = st.homepage
        const conclusion =
          home.kind === 'ok'
            ? '✅ Cookie 有效'
            : home.kind === 'challenge'
              ? '⚠️ Cookie 无效/过期，下次请求会自动重破'
              : home.kind === 'network-error'
                ? '❌ 请求失败（网络问题，不是反爬也不是 Cookie 失效）'
                : `❌ 站点返回 HTTP ${home.status}（不是反爬问题，可能是服务端故障）`
        return [
          '📊 可可影视凭证状态',
          `Cookie：${st.cookieLength > 0 ? `已设置（${st.cookieLength} 字符${st.manualCookie ? '，来自面板手动配置' : ''}）` : '未设置'}`,
          `t 参数：${st.t ? `已设置（${st.t}）` : '未设置'}`,
          `缓存：${st.fresh ? '新鲜，20 分钟内不再请求首页' : '已过期，下次请求会重新获取'}`,
          `首页：HTTP ${home.status}`,
          `结论：${conclusion}`,
        ].join('\n')
      },
    },

    '看剧 刷新': {
      description: '强制重破反爬、刷新凭证',
      permission: 'bot_admin',
      async handler({ ctx }) {
        const client = createKkys({ kv: ctx.kv, logger: ctx.logger, config: ctx.config, fetch })
        const started = Date.now()
        const creds = await client.ensureReady(true)
        if (!creds) return '❌ 刷新失败：破解反爬或首页请求没通过，看日志里是哪一种'
        return [
          '✅ 凭证已刷新',
          `Cookie：${creds.cookie.slice(0, 60)}${creds.cookie.length > 60 ? '…' : ''}`,
          `t 参数：${creds.t}`,
          `耗时：${Date.now() - started} ms`,
        ].join('\n')
      },
    },

    一起看: {
      description: '视频直链转一起看房间链接',
      usage: '/一起看 <视频直链>',
      handler({ ctx, argText }) {
        const videoUrl = argText.trim()
        if (!videoUrl) return '用法：/一起看 <m3u8/mp4 直链>'
        if (!/^https?:\/\//i.test(videoUrl)) return '请给完整的 http(s) 直链'
        const room = buildWatchTogetherUrl(videoUrl, ctx.config.watchTogetherBase)
        const expiry = describePlayUrlExpiry(videoUrl)
        const lines = ['👥 一起看房间链接（发给好友同步观看）：', room]
        if (expiry) {
          lines.push('', `⏳ ${expiry}`, '房间链接本身长期有效，但它引用的视频直链会过期，过期后房间需要重新生成')
        }
        return lines.join('\n')
      },
    },
  },

  buttons: {
    /** 选片：拉详情、存会话、列出线路 */
    async pick({ ctx, buttonData }) {
      const client = createKkys({ kv: ctx.kv, logger: ctx.logger, config: ctx.config, fetch })
      const [, sid, idxText] = buttonData.split(':')
      const state = await loadSession(ctx, sid)
      const picked = state?.results?.[Number(idxText)]
      if (!state || !picked) return '会话已过期，请重新发 /看剧 <片名>'

      const detail = await client.detail(picked.u)
      if (!detail) return '❌ 详情页解析失败，稍后再试'
      const ordered = orderLines(detail.lines)
      if (ordered.length === 0) return `😞「${detail.title || picked.t}」暂无可用线路`

      const next: SessionState = {
        kw: state.kw,
        title: detail.title || picked.t,
        detailUrl: picked.u,
        lines: ordered.map((l) => ({ name: l.name, sub: l.sublabel, n: l.episodes.length })),
        flat: serializeFlat(ordered.flatMap((l) => l.episodes)),
        ts: Date.now(),
      }
      await ctx.kv.put(`k:${sid}`, next, { ttl: SESSION_TTL_SECONDS })

      const rows: ReturnType<typeof button.callback>[][] = []
      for (let i = 0; i < ordered.length && i < 15; i += 5) {
        rows.push(
          ordered
            .slice(i, i + 5)
            .map((line, j) => button.callback(lineLabel(line.name, line.sublabel), `line:${sid}:${i + j}`, { id: 'line' })),
        )
      }
      const total = next.lines.reduce((sum, l) => sum + l.n, 0)
      return {
        text: `🎬 ${next.title}\n共 ${next.lines.length} 条线路、${total} 集\n\n👉 选一条线路看剧集`,
        keyboard: keyboard(rows),
        quote: true,
      }
    },

    /** 选线路 → 列出该线路的剧集（默认末页，也就是最新几集） */
    async line({ ctx, buttonData }) {
      const [, sid, idxText] = buttonData.split(':')
      const state = await loadSession(ctx, sid)
      if (!state) return '会话已过期，请重新发 /看剧 <片名>'
      const lineIdx = Number(idxText)
      const line = sessionLines(state)[lineIdx]
      if (!line) return '线路不存在，请重新选片'
      return episodePageReply(state, sid ?? '', lineIdx, line, Number.NaN)
    },

    /** 剧集翻页 */
    async page({ ctx, buttonData }) {
      const [, sid, idxText, pageText] = buttonData.split(':')
      const state = await loadSession(ctx, sid)
      if (!state) return '会话已过期，请重新发 /看剧 <片名>'
      const lineIdx = Number(idxText)
      const line = sessionLines(state)[lineIdx]
      if (!line) return '线路不存在，请重新选片'
      return episodePageReply(state, sid ?? '', lineIdx, line, Number(pageText))
    },

    /** 选集 → 播放直链 */
    async ep({ ctx, buttonData }) {
      const client = createKkys({ kv: ctx.kv, logger: ctx.logger, config: ctx.config, fetch })
      const [, sid, idxText, epText] = buttonData.split(':')
      const state = await loadSession(ctx, sid)
      if (!state) return '会话已过期，请重新发 /看剧 <片名>'
      const lineIdx = Number(idxText)
      const line = sessionLines(state)[lineIdx]
      const episode = line?.episodes[Number(epText)]
      if (!line || !episode) return '剧集不存在，请重新选片'
      const url = await client.playUrl(episode.url)
      if (!isValidPlayUrl(url)) return `❌「${episode.name}」没取到播放链接，换条线路或换集试试`
      state.playUrl = url as string
      state.lineIdx = lineIdx
      state.epIdx = Number(epText)
      state.ts = Date.now()
      await ctx.kv.put(`k:${sid}`, state, { ttl: SESSION_TTL_SECONDS })
      return {
        text: buildPlayMessage({
          title: state.title,
          episodeName: episode.name,
          lineName: line.name,
          lineSublabel: line.sublabel,
          playUrl: url as string,
          watchTogetherBase: ctx.config.watchTogetherBase,
        }),
        keyboard: playKeyboard(sid ?? ''),
        quote: true,
      }
    },

    /** 当前线路的最新一集 */
    async latest({ ctx, buttonData }) {
      const client = createKkys({ kv: ctx.kv, logger: ctx.logger, config: ctx.config, fetch })
      const [, sid] = buttonData.split(':')
      const state = await loadSession(ctx, sid)
      if (!state) return '会话已过期，请重新发 /看剧 <片名>'
      const lines = sessionLines(state)
      const line = lines[state.lineIdx ?? 0] ?? lines[0]
      const episode = line?.episodes[line.episodes.length - 1]
      if (!line || !episode) return '没找到可用的剧集'
      const url = await client.playUrl(episode.url)
      if (!isValidPlayUrl(url)) return `❌「${episode.name}」没取到播放链接，换条线路试试`
      state.playUrl = url as string
      state.epIdx = line.episodes.length - 1
      state.ts = Date.now()
      await ctx.kv.put(`k:${sid}`, state, { ttl: SESSION_TTL_SECONDS })
      return {
        text: buildPlayMessage({
          title: state.title,
          episodeName: episode.name,
          lineName: line.name,
          lineSublabel: line.sublabel,
          playUrl: url as string,
          watchTogetherBase: ctx.config.watchTogetherBase,
        }),
        keyboard: playKeyboard(sid ?? ''),
        quote: true,
      }
    },

    /** 用会话里缓存的直链生成一起看房间链接，不重新解析 */
    async yqt({ ctx, buttonData }) {
      const [, sid] = buttonData.split(':')
      const state = await loadSession(ctx, sid)
      if (!state?.playUrl) return '这条会话里还没有播放直链，先选一集'
      const room = buildWatchTogetherUrl(state.playUrl, ctx.config.watchTogetherBase)
      const expiry = describePlayUrlExpiry(state.playUrl)
      const parts = ['👥 一起看房间链接（发给好友同步观看）：', room]
      if (expiry) parts.push('', `⏳ ${expiry}`)
      return { text: parts.join('\n'), quote: true }
    },
  },

  events: {
    'qq.group.robot_added': () => '🍿 我是可可影视机器人，发 /看剧 <片名> 拿播放直链，例如 /看剧 斗罗大陆 120',
  },
})
