/**
 * 纯函数测试：页面解析、反爬破解、链接工具。
 * HTML 样本来自真实页面（`src/__fixtures__/`），改解析正则时对着样本改。
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildWatchTogetherUrl,
  describePlayUrlExpiry,
  deserializeFlat,
  extractPlayUrl,
  isChallenge,
  isRelevantTitle,
  isValidPlayUrl,
  orderLines,
  parseCdndefendChallenge,
  parseDetail,
  parseSearchResults,
  parseTParam,
  pickEpisode,
  serializeFlat,
  sliceLines,
  solveCdndefend,
  type Episode,
  type PlayLine,
} from './index.js'
import challengeHtml from './__fixtures__/challenge.html?raw'
import detailHtml from './__fixtures__/detail.html?raw'
import playHtml from './__fixtures__/play.html?raw'
import searchHtml from './__fixtures__/search.html?raw'

const BASE = 'https://www.kkys01.com'

function episode(lineId: string, episodeId: string, name: string): Episode {
  return { name, url: `${BASE}/play/100-${lineId}-${episodeId}.html`, vodId: '100', lineId, episodeId }
}

describe('cdndefend 反爬', () => {
  it('解析挑战页：数组旋转后取第 3 个元素，n1 取首字符 hex', () => {
    expect(parseCdndefendChallenge(challengeHtml)).toEqual({
      c: '951BE52B307594052B23646F980E2B9CF6500697',
      n1: 9,
    })
  })

  it('格式变了就返回 null（正则失配是「破解失败」的信号）', () => {
    expect(parseCdndefendChallenge('<html>普通页面</html>')).toBeNull()
    expect(parseCdndefendChallenge("const a0_0x2a54=['only-one'];")).toBeNull()
  })

  it('PoW 解出的 i 能通过原生 SHA-1 校验', () => {
    const parsed = parseCdndefendChallenge(challengeHtml)
    expect(parsed).not.toBeNull()
    const { c, n1 } = parsed!
    const i = solveCdndefend(c, n1, 1_000_000)
    expect(i).toBeGreaterThanOrEqual(0)
    const digest = createHash('sha1').update(c + i).digest()
    expect(digest[n1]).toBe(0xb0)
    expect(digest[n1 + 1]).toBe(0x0b)
  })

  it('穷举上限内没命中就返回 -1', () => {
    const parsed = parseCdndefendChallenge(challengeHtml)!
    expect(solveCdndefend(parsed.c, parsed.n1, 10)).toBe(-1)
  })

  it('850 与挑战页都算命中反爬', () => {
    expect(isChallenge(850, '')).toBe(true)
    expect(isChallenge(200, '<script>cdndefend</script>')).toBe(true)
    expect(isChallenge(200, '<html>正常页面</html>')).toBe(false)
  })
})

describe('首页 t 参数', () => {
  it('从隐藏 input 取原值（不 URL 解码）', () => {
    expect(parseTParam('<input type="hidden" name="t" value="+tZ8J3cRVqj9wFb+Ornp/A=="/>')).toBe(
      '+tZ8J3cRVqj9wFb+Ornp/A==',
    )
  })

  it('回退到搜索链接并 URL 解码', () => {
    expect(parseTParam('<a href="/search?t=abc%2Bdef%3D%3D&k=x">搜索</a>')).toBe('abc+def==')
  })

  it('没有就返回 null', () => {
    expect(parseTParam('<html><body>nothing</body></html>')).toBeNull()
  })
})

describe('搜索结果解析', () => {
  const results = parseSearchResults(searchHtml)

  it('取出全部结果项', () => {
    expect(results.map((r) => r.title)).toEqual(['斗罗大陆2绝世唐门', '斗罗大陆5重生唐三·动态漫画', '斗罗大陆角色篇'])
  })

  it('标题/标签/类型/链接都对得上', () => {
    expect(results[0]).toMatchObject({
      title: '斗罗大陆2绝世唐门',
      year: '2023',
      country: '中国大陆',
      genre: '动漫',
      detailUrl: `${BASE}/detail/172932.html`,
      vodId: '172932',
    })
    expect(results[1]?.year).toBe('2025')
    expect(results[2]?.detailUrl).toBe(`${BASE}/detail/386500.html`)
  })

  it('actors / desc 也解析出来了', () => {
    expect(results[0]?.actors.length).toBeGreaterThan(0)
    expect(results[0]?.desc).toContain('武魂')
  })

  it('没有结果项时返回空数组', () => {
    expect(parseSearchResults('<html><body>没有内容</div></body></html>')).toEqual([])
  })
})

describe('详情页解析', () => {
  it('标题取含汉字的最长一行，跳过 𝕜𝕜𝕪𝕤𝟘𝟙.𝕔𝕠𝕞 装饰行', () => {
    const detail = parseDetail(detailHtml, `${BASE}/detail/172932.html`)
    expect(detail.title).toBe('斗罗大陆2绝世唐门')
  })

  it('声明集数与实际剧集数对不上时，退化为按 lineId 分组', () => {
    // 样本里 4 条线路声明 644 集，实际只截了 8 个 episode-item
    const detail = parseDetail(detailHtml, `${BASE}/detail/172932.html`)
    expect(detail.lines.map((l) => [l.name, l.id, l.episodes.length])).toEqual([['线路41', '41', 8]])
  })

  it('按 source-item-num 累计切片还原线路↔剧集（一条线路被多个入口复用也不会错位）', () => {
    const html = `
      <div class="detail-title"><strong>测试剧</strong></div>
      <a href="#" class="source-item source-item-active"><span class="source-item-label">线路A</span><span class="source-item-sublabel">高清</span><i class="source-item-num">2</i></a>
      <a href="#" class="source-item "><span class="source-item-label">线路B</span><i class="source-item-num">1</i></a>
      <a href="#" class="source-item "><span class="source-item-label">线路C</span><i class="source-item-num">2</i></a>
      <a href="/play/100-41-1.html" class="episode-item" data-index="1"><span>第1集</span></a>
      <a href="/play/100-41-2.html" class="episode-item" data-index="2"><span>第2集</span></a>
      <a href="/play/100-35-1.html" class="episode-item" data-index="1"><span>第1集</span></a>
      <a href="/play/100-4-1.html" class="episode-item" data-index="1"><span>第1集</span></a>
      <a href="/play/100-4-2.html" class="episode-item" data-index="2"><span>第2集</span></a>
    `
    const detail = parseDetail(html, `${BASE}/detail/100.html`)
    expect(detail.lines.map((l) => [l.name, l.id, l.episodes.length])).toEqual([
      ['线路A', '41', 2],
      ['线路B', '35', 1],
      ['线路C', '4', 2],
    ])
    expect(detail.lines[2]?.episodes[1]?.url).toBe(`${BASE}/play/100-4-2.html`)
    expect(detail.lines[1]?.sublabel).toBe('')
  })

  it('集数声明为 0 或没有剧集时不乱挂', () => {
    const html = `
      <a href="#" class="source-item"><span class="source-item-label">空线路</span><i class="source-item-num">0</i></a>
      <a href="/play/100-41-1.html" class="episode-item"><span>第1集</span></a>
    `
    const detail = parseDetail(html, `${BASE}/detail/100.html`)
    expect(detail.lines.map((l) => [l.name, l.episodes.length])).toEqual([['线路41', 1]])
  })
})

describe('播放链接', () => {
  it('从 playSource 里取 m3u8', () => {
    const url = extractPlayUrl(playHtml)
    expect(url).toContain('142.248.97.203:21306')
    expect(url).toContain('/index.m3u8?appId=kkdy')
    expect(url).toContain('timestamp=1792170832')
  })

  it('兜底正则能抓裸 mp4 链接', () => {
    expect(extractPlayUrl('<script>var u = "https://cdn.example.com/a/b.mp4?x=1";</script>')).toBe(
      'https://cdn.example.com/a/b.mp4?x=1',
    )
  })

  it('没有链接时返回 null', () => {
    expect(extractPlayUrl('<html><body>没有播放源</body></html>')).toBeNull()
  })

  it('按 path 扩展名判断有效性，不受查询串影响', () => {
    expect(isValidPlayUrl('https://cdn.example.com/a/index.m3u8?appId=kkdy&sign=x&timestamp=1&ref=0')).toBe(true)
    expect(isValidPlayUrl('https://cdn.example.com/a/INDEX.MP4?a=1')).toBe(true)
    expect(isValidPlayUrl('https://cdn.example.com/play/1-2-3.html?f=a.m3u8')).toBe(false)
    expect(isValidPlayUrl('')).toBe(false)
    expect(isValidPlayUrl(null)).toBe(false)
  })
})

describe('时效提示与一起看链接', () => {
  it('签发时间按 UTC+8 显示', () => {
    const timestamp = Math.floor(new Date('2026-10-17T06:23:11Z').getTime() / 1000)
    const text = describePlayUrlExpiry(`https://cdn.example.com/a/index.m3u8?sign=x&timestamp=${timestamp}`)
    expect(text).toContain('签发于 2026-10-17 14:23:11')
    expect(text).toContain('过期后需重新解析')
    expect(text).not.toContain('页面缓存')
  })

  it('签发超过 30 分钟提示可能来自页面缓存', () => {
    const timestamp = Math.floor((Date.now() - 61 * 60 * 1000) / 1000)
    expect(describePlayUrlExpiry(`https://cdn.example.com/a/index.m3u8?timestamp=${timestamp}`)).toContain(
      '来自页面缓存',
    )
  })

  it('没有 timestamp 就不提示', () => {
    expect(describePlayUrlExpiry('https://cdn.example.com/a/index.m3u8?sign=x')).toBeNull()
    expect(describePlayUrlExpiry('不是链接')).toBeNull()
  })

  it('一起看链接整体编码直链', () => {
    expect(buildWatchTogetherUrl('https://cdn.example.com/a/index.m3u8?sign=x&timestamp=1')).toBe(
      'https://yqk.060908.xyz/watch.html?url=https%3A%2F%2Fcdn.example.com%2Fa%2Findex.m3u8%3Fsign%3Dx%26timestamp%3D1',
    )
    expect(buildWatchTogetherUrl('https://x/y.m3u8', 'https://room.example.com/watch.html')).toBe(
      'https://room.example.com/watch.html?url=https%3A%2F%2Fx%2Fy.m3u8',
    )
  })
})

describe('标题相关性', () => {
  it('同系列/子串算相关', () => {
    expect(isRelevantTitle('斗罗大陆2绝世唐门', '斗罗大陆')).toBe(true)
    expect(isRelevantTitle('斗罗大陆', '斗罗大陆2绝世唐门')).toBe(true)
  })

  it('完全无关的兜底结果被剔除', () => {
    expect(isRelevantTitle('巨舞霸', '甄嬛传之终章')).toBe(false)
    expect(isRelevantTitle('心有所依', '甄嬛传之终章')).toBe(false)
  })

  it('空字符串不误杀', () => {
    expect(isRelevantTitle('', '斗罗大陆')).toBe(true)
    expect(isRelevantTitle('斗罗大陆', '')).toBe(true)
  })
})

describe('线路与剧集', () => {
  const line = (name: string, count: number): PlayLine => ({
    id: name,
    name,
    sublabel: '',
    episodes: Array.from({ length: count }, (_, i) => episode(name, String(i + 1), `第${i + 1}集`)),
  })

  it('4K 线路排到最后', () => {
    expect(orderLines([line('4K', 3), line('超清2', 3), line('空线路', 0)]).map((l) => l.name)).toEqual(['超清2', '4K'])
  })

  it('按集数选集：先匹配剧集名里的数字，再退回按序号', () => {
    const eps = [episode('41', '11', '第1集'), episode('41', '12', '第2集'), episode('41', '13', '第10集')]
    expect(pickEpisode(eps, 10)?.name).toBe('第10集')
    expect(pickEpisode(eps, 2)?.name).toBe('第2集')
    expect(pickEpisode(eps, 0)?.name).toBe('第1集')
    // 超出实际集数：返回 null，让上层报「该集还没上线」，不要硬凑一集
    expect(pickEpisode(eps, 99)).toBeNull()
    expect(pickEpisode([], 1)).toBeNull()
  })

  it('扁平剧集序列化后能还原出播放页 URL', () => {
    const eps = [episode('41', '15484', '第1集'), episode('35', '99', '第1集')]
    const back = deserializeFlat(serializeFlat(eps), '172932')
    expect(back).toEqual([
      { name: '第1集', url: `${BASE}/play/172932-41-15484.html`, vodId: '172932', lineId: '41', episodeId: '15484' },
      { name: '第1集', url: `${BASE}/play/172932-35-99.html`, vodId: '172932', lineId: '35', episodeId: '99' },
    ])
  })

  it('切片按声明的集数切回各线路', () => {
    const flat = [
      episode('41', '1', '第1集'),
      episode('41', '2', '第2集'),
      episode('35', '1', '第1集'),
      episode('4', '1', '第1集'),
    ]
    const lines = sliceLines(
      [
        { name: 'A', sub: '高清', n: 2 },
        { name: 'B', sub: '', n: 1 },
        { name: 'C', sub: '', n: 1 },
      ],
      flat,
    )
    expect(lines.map((l) => [l.name, l.id, l.episodes.length])).toEqual([
      ['A', '41', 2],
      ['B', '35', 1],
      ['C', '4', 1],
    ])
  })

  it('声明集数与实际对不上时按 lineId 分组', () => {
    const flat = [episode('41', '1', '第1集'), episode('41', '2', '第2集'), episode('35', '1', '第1集')]
    const lines = sliceLines([{ name: 'A', sub: '', n: 99 }], flat)
    expect(lines.map((l) => [l.name, l.episodes.length])).toEqual([
      ['线路41', 2],
      ['线路35', 1],
    ])
  })
})
