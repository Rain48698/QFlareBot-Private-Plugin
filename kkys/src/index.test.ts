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

/**
 * QQ 的按键 label 上限按**显示宽度**算（汉字等非 ASCII 算 2、英文数字算 1），不是字符数。
 * `FF线路·播放快/高清` 只有 11 个字符、宽度 16，按字符数截断看着没超、实际会被平台截在半个词上。
 */
function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) <= 0x7f ? 1 : 2
  return w
}

function labelsOf(result: unknown): string[] {
  return (keyboardOf(result)?.rows ?? []).flatMap((r) => r.buttons.map((b) => b.render_data.label))
}

function datasOf(result: unknown): string[] {
  return (keyboardOf(result)?.rows ?? []).flatMap((r) => r.buttons.map((b) => b.action?.data ?? ''))
}

/** 每个按键的 data 前缀都必须是插件真有的处理器名——写错时不报错、只点了没反应 */
function assertButtonIdsExist(result: unknown): void {
  const keys = new Set(Object.keys(plugin.buttons ?? {}))
  const missing = [...new Set(datasOf(result).map((d) => d.split(':')[0]!))].filter((k) => !keys.has(k))
  expect(missing).toEqual([])
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

  it('看剧 状态：现解凭证并真打一次搜索，结论以搜索为准', async () => {
    stubSite()
    const { result } = await runCommandDirect('看剧 状态')
    const text = textOf(result)
    expect(text).toContain('可可影视反爬体检')
    // 解算耗时要报出来——免费版 10ms CPU 的判断依据
    expect(text).toContain('解算耗时')
    // 关键：结论来自「搜索探测」，不是只看首页
    expect(text).toContain('搜索探测')
    expect(text).toContain('✅ 正常')
  })

  it('看剧 状态：搜索被拦时明确报出来（不谎报正常）', async () => {
    // 首页放行、搜索一直 850：模拟「凭证刚好用到失效」
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
        const url = typeof input === 'string' ? input : String((input as Request).url)
        const cookie = init?.headers?.cookie ?? null
        if (url === BASE || url === `${BASE}/`) {
          if (!cookie) return fakeResponse(challengeHtml, 850)
          return fakeResponse(homeHtml, 200)
        }
        if (url.includes('/search?')) return fakeResponse(challengeHtml, 850)
        return fakeResponse('', 404)
      }),
    )
    const { result } = await runCommandDirect('看剧 状态')
    const text = textOf(result)
    expect(text).toContain('搜索仍被反爬拦截')
    expect(text).not.toContain('✅ 正常')
  })

  it('看剧 刷新：用真实搜索验证，通了才报成功', async () => {
    stubSite()
    const { result } = await runCommandDirect('看剧 刷新')
    const text = textOf(result)
    expect(text).toContain('刷新成功')
    expect(text).toContain('已用真实搜索验证')
    // 桩数据里「测试」搜不到，所以这里是 0 条——关键断言是「搜索这一路真的走通了」
    expect(text).toMatch(/搜索「测试」拿到 \d+ 条结果/)
    // 不再回显完整 cookie（一次性凭证，回显没意义）
    expect(text).not.toContain('cdndefend_js_cookie=')
  })

  it('看剧 刷新：搜索不通时如实报失败并给排查方向', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = typeof input === 'string' ? input : String((input as Request).url)
        if (url === BASE || url === `${BASE}/`) return fakeResponse(challengeHtml, 850)
        // 搜索始终 850：模拟凭证一次性导致重试也救不回来
        return fakeResponse(challengeHtml, 850)
      }),
    )
    const { result } = await runCommandDirect('看剧 刷新')
    const text = textOf(result)
    expect(text).toContain('刷新失败')
    expect(text).toContain('10 ms CPU')
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

  it('「换线路」按键能回到线路列表，且不再请求站点', async () => {
    const calls = stubSite()
    const { ctx } = await runCommandDirect('看剧', '斗罗大陆')
    const sid = await firstSessionId(ctx)
    await buttons.pick!({ ctx, buttonData: `pick:${sid}:0` })
    const before = calls.length

    const lines = await buttons.lines!({ ctx, buttonData: `lines:${sid}` })
    const text = textOf(lines)
    expect(text).toContain('斗罗大陆2绝世唐门')
    expect(text).toContain('共 1 条线路')
    expect(calls.length).toBe(before)
  })

  it('播放结果里的「换线路」按键指向真的存在的处理器', async () => {
    stubSite()
    const { ctx } = await runCommandDirect('看剧', '斗罗大陆 2')
    const sid = await firstSessionId(ctx)
    // 摊平按键：label 与 action.data 都要有，data 的前缀就是 buttons 的 key
    const reply = await buttons.latest!({ ctx, buttonData: `latest:${sid}` })
    const buttonsOf = (keyboardOf(reply)?.rows ?? []).flatMap((r) =>
      r.buttons.map((b) => ({
        label: b.render_data.label,
        data: (b as unknown as { action: { data?: string } }).action.data ?? '',
      })),
    )
    const change = buttonsOf.find((b) => b.label === '换线路')
    expect(change).toBeTruthy()
    // 关键断言：按键 id 必须是插件真有的处理器名（此前错写成 lines 之外的东西会静默无响应）
    expect(change?.data.startsWith('lines:')).toBe(true)
    expect(Object.keys(plugin.buttons ?? {})).toContain('lines')
  })

  it('只有一条线路时不显示「换线路」按键（点进去还是同一条，纯噪音）', async () => {
    stubSite()
    const ctx = newCtx()
    const sid = 'oneline'
    await ctx.kv.put(`k:${sid}`, {
      kw: '测试',
      title: '测试剧',
      detailUrl: `${BASE}/detail/100.html`,
      lines: [{ name: '线路A', sub: '', n: 3 }],
      flat: '41-1\t第1集\n41-2\t第2集\n41-3\t第3集',
      ts: Date.now(),
    })
    const reply = await buttons.line!({ ctx, buttonData: `line:${sid}:0` })
    const labels = (keyboardOf(reply)?.rows ?? []).flatMap((r) => r.buttons.map((b) => b.render_data.label))
    expect(labels).toEqual(['第1集', '第2集', '第3集'])
  })

  it('一次命令只请求两次首页（凭证在同一次事件内复用，不再重复确认）', async () => {
    const calls = stubSite()
    await runCommandDirect('看剧', '斗罗大陆 2')
    const homeHits = calls.filter((c) => c.url === BASE || c.url === `${BASE}/`).length
    // 第一次无 Cookie 拿到 850 + 挑战页，第二次带解出来的 Cookie 拿到正常首页；不该有第三次
    expect(homeHits).toBe(2)
  })

  it('线路按键 label 按显示宽度截断，不是字符数（平台按宽度算）', async () => {
    const ctx = newCtx()
    const sid = 'wide'
    // 真机上出现过的长组合：11 个字符、显示宽度 16
    await ctx.kv.put(`k:${sid}`, {
      kw: '测试',
      title: '测试剧',
      detailUrl: `${BASE}/detail/100.html`,
      lines: [
        { name: 'FF线路', sub: '播放快/高清', n: 1 },
        { name: 'HN线路', sub: '中国大陆加速', n: 1 },
        { name: '蓝光1', sub: '香港加速', n: 1 },
      ],
      flat: '41-1\t第1集\n4-2\t第1集\n27-3\t第1集',
      ts: Date.now(),
    })
    const reply = await buttons.lines!({ ctx, buttonData: `lines:${sid}` })
    const labels = labelsOf(reply)
    expect(labels.length).toBe(3)
    for (const label of labels) {
      // 平台软上限约 16 显示宽度；超了会被截在半个词上（"中国大陆加速" → "中国大陆加"）
      expect(displayWidth(label)).toBeLessThanOrEqual(16)
    }
    // 短的保持原样，长的带省略号而不是硬切
    expect(labels).toContain('蓝光1·香港加速')
    expect(labels.some((l) => l.endsWith('…'))).toBe(true)
    assertButtonIdsExist(reply)
  })

  it('所有能产出按键的回复，按键 data 都指向真有的处理器', async () => {
    stubSite()
    const { ctx, result: searchReply } = await runCommandDirect('看剧', '斗罗大陆')
    assertButtonIdsExist(searchReply)
    const sid = await firstSessionId(ctx)
    const pick = await buttons.pick!({ ctx, buttonData: `pick:${sid}:0` })
    assertButtonIdsExist(pick)
    const line = await buttons.line!({ ctx, buttonData: `line:${sid}:0` })
    assertButtonIdsExist(line)
    const ep = await buttons.ep!({ ctx, buttonData: `ep:${sid}:0:1` })
    assertButtonIdsExist(ep)
    const latest = await buttons.latest!({ ctx, buttonData: `latest:${sid}` })
    assertButtonIdsExist(latest)
  })
})

describe('凭证生命周期（cdndefend 的 cookie 是一次性的）', () => {
  /**
   * 这是真机踩出来的核心 bug：cookie 解出来只能用很短时间，等 5 秒就 850。
   * 旧实现把它存 KV 12 小时，于是第一次用成功、之后全失败。
   * 下面两条把「不跨事件复用」和「失效必须重解」钉住。
   */
  it('KV 里超过 5 秒的旧凭证不会被拿来用', async () => {
    const calls = stubSite()
    const ctx = newCtx()
    // 塞一条 10 秒前的「有效」凭证
    await ctx.kv.put('creds', {
      cookie: 'cdndefend_js_cookie=STALE_TOKEN_OLD',
      t: 'STALE_T_PARAM',
      ts: Date.now() - 10_000,
    })
    await runCommandDirect('看剧', '斗罗大陆', ctx)
    // 必须重新跑一遍首页 + 解算，而不是直接用 STALE
    const staleUsed = calls.some((c) => c.cookie?.includes('STALE_TOKEN_OLD'))
    expect(staleUsed).toBe(false)
    // 首页至少被请求了两次（无 cookie 拿 850 → 带新 cookie 拿 200）
    expect(calls.filter((c) => c.url === BASE || c.url === `${BASE}/`).length).toBeGreaterThanOrEqual(2)
  })

  it('搜索连续被拦时会换新凭证重试（默认 2 次，为 CPU 预算让路）', async () => {
    let searchHits = 0
    let homeHits = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
        const url = typeof input === 'string' ? input : String((input as Request).url)
        const cookie = init?.headers?.cookie ?? null
        if (url === BASE || url === `${BASE}/`) {
          homeHits += 1
          if (!cookie) return fakeResponse(challengeHtml, 850)
          return fakeResponse(homeHtml, 200)
        }
        if (url.includes('/search?')) {
          searchHits += 1
          // 第一次拦、第二次放行：证明「换新凭证重试」这条链路通
          return searchHits < 2 ? fakeResponse(challengeHtml, 850) : fakeResponse(searchHtml, 200)
        }
        return fakeResponse('', 404)
      }),
    )
    const { result } = await runCommandDirect('看剧', '斗罗大陆')
    // 默认 attempts=2：被拦一次、换凭证后成功
    expect(searchHits).toBe(2)
    expect(homeHits).toBeGreaterThan(2)
    expect(textOf(result)).toContain('斗罗大陆2绝世唐门')
  })

  it('两次都被拦时如实失败，不会无限重试烧 CPU', async () => {
    let searchHits = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
        const url = typeof input === 'string' ? input : String((input as Request).url)
        const cookie = init?.headers?.cookie ?? null
        if (url === BASE || url === `${BASE}/`) {
          if (!cookie) return fakeResponse(challengeHtml, 850)
          return fakeResponse(homeHtml, 200)
        }
        if (url.includes('/search?')) {
          searchHits += 1
          return fakeResponse(challengeHtml, 850)
        }
        return fakeResponse('', 404)
      }),
    )
    const { result } = await runCommandDirect('看剧', '斗罗大陆')
    expect(textOf(result)).toContain('搜索失败')
    // 只试 2 次（含换凭证重试），不无限循环——每次都是真 PoW，免费版 CPU 撑不住更多
    expect(searchHits).toBe(2)
  })
})

describe('事件', () => {
  it('入群欢迎语里带用法', () => {
    const events = plugin.events as unknown as Record<string, (input: HandlerInput) => unknown>
    const reply = events['qq.group.robot_added']!({ ctx: newCtx() })
    expect(textOf(reply)).toContain('/看剧')
  })
})
