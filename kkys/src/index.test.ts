/**
 * 命令与按键的端到端测试：用桩 fetch 走完整链路（首页 → 搜索 → 详情 → 播放页），
 * 断言回复内容、反爬自动破解、以及按键会话。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockContext, createMockSession } from '@qqbot/sdk/testing'
import plugin from './index.js'
import challengeHtml from './__fixtures__/challenge.html?raw'
import detailHtml from './__fixtures__/detail.html?raw'
import homeHtml from './__fixtures__/home.html?raw'
import playHtml from './__fixtures__/play.html?raw'
import searchHtml from './__fixtures__/search.html?raw'

const BASE = 'https://www.kkys01.com'

interface RecordedCall {
  url: string
  cookie: string | null
}

/**
 * 桩 fetch：不带 Cookie 或 Cookie 无效时首页返回 850 + 挑战页（和站点一样），
 * 带上解出来的 Cookie 才给正常首页。
 *
 * 不能用 `new Response(body, { status: 850 })` —— Node 的 Response 构造函数只收
 * 200..599，850 会直接抛 RangeError，看起来就像「网络失败」。给个最小对象即可，
 * 代码只用 status 和 text()。
 */
function fakeResponse(body: string, status = 200): { status: number; text(): Promise<string> } {
  return { status, text: async () => body }
}

function stubSite(): RecordedCall[] {
  const calls: RecordedCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const url = typeof input === 'string' ? input : String((input as Request).url)
      const cookie = init?.headers?.cookie ?? null
      calls.push({ url, cookie })
      if (url === BASE || url === `${BASE}/`) {
        if (!cookie) return fakeResponse(challengeHtml, 850)
        return fakeResponse(homeHtml, 200)
      }
      if (url.includes('/search?')) return fakeResponse(searchHtml, 200)
      if (url.includes('/detail/')) return fakeResponse(detailHtml, 200)
      if (url.includes('/play/')) return fakeResponse(playHtml, 200)
      return fakeResponse('not found', 404)
    }),
  )
  return calls
}

type HandlerInput = Record<string, unknown>
interface CommandSpec {
  handler: (input: HandlerInput) => unknown
}
interface ButtonSpec {
  (input: HandlerInput): unknown
}

const commands = plugin.commands as unknown as Record<string, CommandSpec | ((input: HandlerInput) => unknown)>
const buttons = plugin.buttons as unknown as Record<string, ButtonSpec>

function newCtx() {
  return createMockContext(plugin, {
    config: { ...(plugin.defaultConfig as unknown as Record<string, unknown>) } as never,
  })
}

function handlerOf(name: string): CommandSpec {
  const raw = commands[name]
  if (!raw) throw new Error(`没有命令 ${name}`)
  return typeof raw === 'function' ? { handler: raw } : raw
}

async function runCommandDirect(name: string, argText = '', ctx = newCtx()) {
  const session = createMockSession({ content: `/${name} ${argText}`.trim() })
  const result = await handlerOf(name).handler({ ctx, session, command: name, args: argText.trim() ? argText.trim().split(/\s+/) : [], argText: argText.trim() })
  return { ctx, session, result }
}

/** 回复可能是字符串，也可能是带 keyboard 的消息对象 */
function textOf(result: unknown): string {
  if (typeof result === 'string') return result
  const message = result as { text?: string; markdown?: { content?: string } }
  return message.text ?? message.markdown?.content ?? ''
}

function keyboardOf(result: unknown): { rows: { buttons: { render_data: { label: string }; action: { data?: string } }[] }[] } | undefined {
  return (result as { keyboard?: { content?: { rows: unknown[] } } }).keyboard?.content as never
}

async function firstSessionId(ctx: { kv: { list(prefix?: string): Promise<string[]> } }): Promise<string> {
  const keys = await ctx.kv.list('k:')
  const key = keys[0]
  if (!key) throw new Error('没有写入会话状态')
  return key.slice(2)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('命令', () => {
  it('不带参数给出用法', async () => {
    const { result } = await runCommandDirect('看剧')
    const text = textOf(result)
    expect(text).toContain('/看剧 <片名>')
    expect(text).toContain('/看剧 <片名> <集数>')
    expect(text).not.toContain('搜 ')
  })

  it('一起看：把直链塞进房间链接并提示时效', async () => {
    const { result } = await runCommandDirect('一起看', 'https://cdn.example.com/a/index.m3u8?sign=x&timestamp=1792170832')
    const text = textOf(result)
    expect(text).toContain('https://yqk.060908.xyz/watch.html?url=https%3A%2F%2Fcdn.example.com%2Fa%2Findex.m3u8')
    expect(text).toContain('链接带时效签名')
  })

  it('一起看：参数不是链接时拒绝', async () => {
    const { result } = await runCommandDirect('一起看', '不是链接')
    expect(textOf(result)).toContain('http(s) 直链')
  })

  it('看剧 <片名> <集数>：搜索 → 最佳线路 → 指定集 → 直链', async () => {
    stubSite()
    const { ctx, result } = await runCommandDirect('看剧', '斗罗大陆 2')
    const text = textOf(result)
    expect(text).toContain('斗罗大陆2绝世唐门 · 第2集')
    expect(text).toContain('/index.m3u8?appId=kkdy')
    expect(text).toContain('watch.html?url=')
    // 会话写进了 KV，按键才能用
    expect(await ctx.kv.list('k:')).toHaveLength(1)
  })

  it('首次请求被反爬拦截时自动破解并带上解出来的 Cookie', async () => {
    const calls = stubSite()
    const { result } = await runCommandDirect('看剧', '斗罗大陆 1')
    expect(textOf(result)).toContain('/index.m3u8?appId=kkdy')
    // 破解出来的 Cookie 与挑战页里的 c 一致（c + 命中 i）
    const solved = calls.find((c) => c.cookie?.startsWith('cdndefend_js_cookie=951BE52B307594052B23646F980E2B9CF6500697'))
    expect(solved).toBeTruthy()
    // 业务请求（搜索/详情/播放）都带着它
    const search = calls.find((c) => c.url.includes('/search?'))
    expect(search?.cookie).toBe(solved?.cookie)
  })

  it('片名本身带数字时不当集数（/看剧 斗罗大陆2 走搜索列表）', async () => {
    stubSite()
    const { result } = await runCommandDirect('看剧', '斗罗大陆2')
    const text = textOf(result)
    expect(text).toContain('🔍「斗罗大陆2」找到 3 条')
    expect(text).toContain('1. 斗罗大陆2绝世唐门')
    // 没有当成「斗罗大陆」+ 第 2 集
    expect(text).not.toContain('第2集')
  })

  it('末尾数字搜不到时退回整串当片名，走搜索列表', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = typeof input === 'string' ? input : String((input as Request).url)
        if (url === BASE || url === `${BASE}/`) return fakeResponse(homeHtml, 200)
        if (url.includes('/search?')) {
          const keyword = decodeURIComponent(url.split('&k=')[1] ?? '')
          // 只有整串「斗罗大陆 2」有结果，「斗罗大陆」这条 mock 里没有
          return fakeResponse(keyword === '斗罗大陆 2' ? searchHtml : '<html><body>没有结果</body></html>', 200)
        }
        return fakeResponse('', 404)
      }),
    )
    const { result } = await runCommandDirect('看剧', '斗罗大陆 2')
    expect(textOf(result)).toContain('🔍「斗罗大陆 2」找到 3 条')
  })

  it('搜不到时如实提示，不编造结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = typeof input === 'string' ? input : String((input as Request).url)
        if (url === BASE || url === `${BASE}/`) return fakeResponse(homeHtml, 200)
        return fakeResponse('<html><body>没有结果</body></html>', 200)
      }),
    )
    const { result } = await runCommandDirect('看剧', '不存在的片子')
    expect(textOf(result)).toContain('没搜到')
  })

  it('网络失败与反爬失败分开报', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const { result } = await runCommandDirect('看剧', '斗罗大陆')
    expect(textOf(result)).toContain('搜索失败')
  })

  it('/看剧 <片名>：列出结果并给出选片按键', async () => {
    stubSite()
    const { result } = await runCommandDirect('看剧', '斗罗大陆')
    const text = textOf(result)
    expect(text).toContain('找到 3 条')
    expect(text).toContain('1. 斗罗大陆2绝世唐门')
    expect(text).toContain('3. 斗罗大陆角色篇')
    const rows = keyboardOf(result)?.rows ?? []
    expect(rows.flatMap((r) => r.buttons.map((b) => b.render_data.label))).toEqual(['1', '2', '3'])
  })

  it('看剧 状态：报告 Cookie / t 参数 / 首页连通性', async () => {
    stubSite()
    const { result } = await runCommandDirect('看剧 状态')
    const text = textOf(result)
    expect(text).toContain('可可影视凭证状态')
    expect(text).toContain('首页：HTTP 850')
    expect(text).toContain('下次请求会自动重破')
  })

  it('看剧 刷新：强制破解并回报凭证', async () => {
    stubSite()
    const { result } = await runCommandDirect('看剧 刷新')
    const text = textOf(result)
    expect(text).toContain('凭证已刷新')
    expect(text).toContain('cdndefend_js_cookie=')
  })
})

describe('按键', () => {
  it('选片 → 选线路 → 选集 → 直链', async () => {
    stubSite()
    const { ctx, result } = await runCommandDirect('看剧', '斗罗大陆')
    expect(textOf(result)).toContain('找到 3 条')
    const sid = await firstSessionId(ctx)

    const pick = await buttons.pick!({ ctx, buttonData: `pick:${sid}:0` })
    expect(textOf(pick)).toContain('斗罗大陆2绝世唐门')
    expect(textOf(pick)).toContain('共 1 条线路、8 集')

    const line = await buttons.line!({ ctx, buttonData: `line:${sid}:0` })
    expect(textOf(line)).toContain('共 8 集')
    const labels = (keyboardOf(line)?.rows ?? []).flatMap((r) => r.buttons.map((b) => b.render_data.label))
    expect(labels).toEqual(['第1集', '第2集', '第3集', '第4集', '第5集', '第6集', '第7集', '第8集'])

    const ep = await buttons.ep!({ ctx, buttonData: `ep:${sid}:0:1` })
    expect(textOf(ep)).toContain('第2集')
    expect(textOf(ep)).toContain('/index.m3u8?appId=kkdy')
  })

  it('剧集翻页：默认末页（最新几集），翻页按钮指向相邻页', async () => {
    const ctx = newCtx()
    const sid = 'pagetest'
    const flat = Array.from({ length: 30 }, (_, i) => `41-${1000 + i}\t第${i + 1}集`).join('\n')
    await ctx.kv.put(`k:${sid}`, {
      kw: '测试',
      title: '测试剧',
      detailUrl: `${BASE}/detail/100.html`,
      lines: [{ name: '线路A', sub: '', n: 30 }],
      flat,
      ts: Date.now(),
    })

    const last = await buttons.line!({ ctx, buttonData: `line:${sid}:0` })
    const lastLabels = (keyboardOf(last)?.rows ?? []).flatMap((r) => r.buttons.map((b) => b.render_data.label))
    expect(lastLabels).toContain('第30集')
    expect(lastLabels).toContain('上一页')
    expect(lastLabels).not.toContain('下一页')

    const mid = await buttons.page!({ ctx, buttonData: `page:${sid}:0:1` })
    const midLabels = (keyboardOf(mid)?.rows ?? []).flatMap((r) => r.buttons.map((b) => b.render_data.label))
    expect(midLabels).toContain('第13集')
    expect(midLabels).toContain('上一页')
    expect(midLabels).toContain('下一页')
    expect(textOf(mid)).toContain('第 13-24 集，第 2/3 页')
  })

  it('一起看按键复用会话里的直链，不再请求站点', async () => {
    const calls = stubSite()
    const { ctx, result } = await runCommandDirect('看剧', '斗罗大陆')
    const sid = await firstSessionId(ctx)
    await buttons.pick!({ ctx, buttonData: `pick:${sid}:0` })
    await buttons.ep!({ ctx, buttonData: `ep:${sid}:0:0` })
    const before = calls.length

    const yqt = await buttons.yqt!({ ctx, buttonData: `yqt:${sid}` })
    expect(textOf(yqt)).toContain('watch.html?url=')
    expect(calls.length).toBe(before)
  })

  it('会话过期时给出明确提示', async () => {
    stubSite()
    const ctx = newCtx()
    const reply = await buttons.pick!({ ctx, buttonData: 'pick:nosuchid:0' })
    expect(textOf(reply)).toContain('会话已过期')
  })
})

describe('事件', () => {
  it('入群欢迎语里带用法', () => {
    const events = plugin.events as unknown as Record<string, (input: HandlerInput) => unknown>
    const reply = events['qq.group.robot_added']!({ ctx: newCtx() })
    expect(textOf(reply)).toContain('/看剧')
  })
})
