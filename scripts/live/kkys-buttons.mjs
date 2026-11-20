/**
 * kkys 第二轮真机验证：按钮链路 + 过滤 + 边界情况。
 *
 * 第一轮验证了「网页解析 → 直链」这条路，这一轮验证插件自己的处理器
 * （commands / buttons）在真实数据上跑出来的东西对不对——尤其是按钮链路，
 * 之前「换线路」的 id 写错就是这里漏掉的。
 *
 * 用法：node scripts/live/kkys-buttons.mjs
 *
 * 打包路径：优先 KKYS_BUNDLE 环境变量，否则 .cache/kkys.mjs
 * （先跑 node scripts/live/build.mjs kkys）。
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BUNDLE_PATH =
  process.env.KKYS_BUNDLE ??
  join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), '.cache', 'kkys.mjs')

const BASE = 'https://www.kkys01.com'
// Windows 上 import() 不收裸路径，必须转成 file:// URL
const mod = await import(pathToFileURL(BUNDLE_PATH).href)

let pass = 0
let fail = 0
const ok = (l, d = '') => { pass++; console.log(`  ✓ ${l}${d ? ` — ${d}` : ''}`) }
const bad = (l, d = '') => { fail++; console.log(`  ✗ ${l}${d ? ` — ${d}` : ''}`) }
const section = (n) => console.log(`\n=== ${n} ===`)

/** 内存 KV，行为与 ctx.kv 的子集一致 */
function memoryKv() {
  const map = new Map()
  return {
    async getJSON(key) {
      const v = map.get(key)
      return v === undefined ? null : JSON.parse(v)
    },
    async put(key, value, opts) {
      map.set(key, JSON.stringify(value))
    },
    async list(prefix = '') {
      return [...map.keys()].filter((k) => k.startsWith(prefix))
    },
    async delete(key) {
      map.delete(key)
    },
  }
}

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: (m, d) => console.log(`    [error] ${m}`, d ?? '') }

function newCtx(configOverrides = {}) {
  return {
    kv: memoryKv(),
    logger,
    config: {
      filterIrrelevant: true,
      maxResults: 8,
      watchTogetherBase: 'https://yqk.060908.xyz/watch.html',
      manualCookie: '',
      ...configOverrides,
    },
  }
}

/** 处理器可能返回字符串，也可能是带 keyboard 的消息对象 */
function textOf(r) {
  if (typeof r === 'string') return r
  return r?.text ?? r?.markdown?.content ?? ''
}
function keyboardLabels(r) {
  const rows = r?.keyboard?.content?.rows ?? []
  return rows.flatMap((row) => row.buttons.map((b) => b.render_data.label))
}
function keyboardData(r) {
  const rows = r?.keyboard?.content?.rows ?? []
  return rows.flatMap((row) => row.buttons.map((b) => b.action?.data ?? ''))
}

const commands = mod.default.commands
const buttons = mod.default.buttons
const handlerOf = (name) => {
  const raw = commands[name]
  if (!raw) throw new Error(`没有命令 ${name}`)
  return typeof raw === 'function' ? raw : raw.handler
}
const runCommand = async (name, argText = '', ctx = newCtx()) => {
  const args = argText.trim() ? argText.trim().split(/\s+/) : []
  return handlerOf(name).call(null, { ctx, session: {}, command: name, args, argText: argText.trim() })
}
const sessionIdOf = async (ctx) => {
  const keys = await ctx.kv.list('k:')
  return keys[0]?.slice(2)
}

// ---------------------------------------------------------------------------

section('1. 不带参数给用法')
{
  const text = textOf(await runCommand('看剧'))
  if (text.includes('/看剧 <片名>') && text.includes('/一起看')) ok('用法文案完整')
  else bad('用法文案缺内容', text.slice(0, 120))
}

section('2. 搜不存在的片名（验证过滤不误报）')
{
  const text = textOf(await runCommand('看剧', 'zzz不存在的片子qqq'))
  if (text.includes('没搜到')) ok('如实回报「没搜到」')
  else bad('没报「没搜到」，可能把无关结果当命中', text.slice(0, 200))
}

section('3. /看剧 <片名>：真实数据 + 选片按键')
let ctx = newCtx()
let searchReply
{
  searchReply = await runCommand('看剧', '斗罗大陆', ctx)
  const text = textOf(searchReply)
  if (/\d+ 条/.test(text)) ok('列出了结果', text.split('\n')[0])
  else bad('结果列表文案异常', text.slice(0, 200))

  const labels = keyboardLabels(searchReply)
  const datas = keyboardData(searchReply)
  if (labels.length > 0) ok('选片按键已生成', `${labels.length} 个：${labels.join(' ')}`)
  else bad('没有生成选片按键')

  // 按键 data 前缀必须是真有的处理器名
  const missing = [...new Set(datas.map((d) => d.split(':')[0]))].filter((k) => !Object.keys(buttons).includes(k))
  if (missing.length === 0) ok('选片按键的处理器都存在')
  else bad('按键指向不存在的处理器', missing.join('、'))

  const sid = await sessionIdOf(ctx)
  if (sid) ok('会话状态已写入 KV', `sid=${sid}`)
  else bad('没有写入会话状态')

  section('4. 点选片按键 → 线路列表')
  const pickIdx = datas[0]?.split(':')[2] ?? '0'
  const pickReply = await buttons.pick({ ctx, buttonData: `pick:${sid}:${pickIdx}` })
  const pickText = textOf(pickReply)
  if (/共 \d+ 条线路/.test(pickText)) ok('线路列表已返回', pickText.split('\n')[1] ?? '')
  else bad('线路列表文案异常', pickText.slice(0, 300))

  const lineLabels = keyboardLabels(pickReply)
  const lineDatas = keyboardData(pickReply)
  if (lineLabels.length > 0) ok('线路按键已生成', `${lineLabels.length} 个：${lineLabels.slice(0, 6).join(' ')}`)
  else bad('没有生成线路按键')

  // 按键 label 上限 10 字
  const tooLong = lineLabels.filter((l) => { let w=0; for (const ch of l) w += (ch.codePointAt(0)??0) <= 0x7f ? 1 : 2; return w > 16 })
  if (tooLong.length === 0) ok('所有线路按键 label 显示宽度 ≤16')
  else bad('有按键 label 显示宽度超过 16', tooLong.join('、'))

  const lmissing = [...new Set(lineDatas.map((d) => d.split(':')[0]))].filter((k) => !Object.keys(buttons).includes(k))
  if (lmissing.length === 0) ok('线路按键的处理器都存在')
  else bad('线路按键指向不存在的处理器', lmissing.join('、'))

  section('5. 点线路 → 剧集列表（默认末页）')
  const lineIdx = lineDatas[0]?.split(':')[2] ?? '0'
  const lineReply = await buttons.line({ ctx, buttonData: `line:${sid}:${lineIdx}` })
  const lineText = textOf(lineReply)
  const epLabels = keyboardLabels(lineReply)
  const epDatas = keyboardData(lineReply)
  if (/共 \d+ 集/.test(lineText)) ok('剧集列表已返回', lineText.split('\n')[0])
  else bad('剧集列表文案异常', lineText.slice(0, 300))
  if (epLabels.length > 0) ok('剧集按键已生成', `${epLabels.length} 个：${epLabels.slice(0, 8).join(' ')}`)
  else bad('没有生成剧集按键')

  const emissing = [...new Set(epDatas.map((d) => d.split(':')[0]))].filter((k) => !Object.keys(buttons).includes(k))
  if (emissing.length === 0) ok('剧集按键的处理器都存在')
  else bad('剧集按键指向不存在的处理器', emissing.join('、'))

  section('6. 「换线路」按键（这次修的 bug）')
  const hasChangeLine = epLabels.includes('换线路')
  const changeData = epDatas.find((d, i) => epLabels[i] === '换线路') ?? ''
  console.log(`    剧集页有没有「换线路」：${hasChangeLine ? '有' : '没有'}；data=${changeData || '(无)'}`)
  if (hasChangeLine) {
    if (changeData.startsWith('lines:')) {
      ok('「换线路」按键 data 指向 lines 处理器')
      const linesReply = await buttons.lines({ ctx, buttonData: changeData })
      const linesText = textOf(linesReply)
      if (/共 \d+ 条线路/.test(linesText)) ok('点「换线路」能回到线路列表', linesText.split('\n')[1] ?? '')
      else bad('「换线路」返回内容异常', linesText.slice(0, 200))
    } else {
      bad('「换线路」的 data 不是 lines: 开头', changeData)
    }
  } else {
    // 只有一条线路时不显示是预期行为；这部片子有 25 条线路，应该显示
    bad('25 条线路的片子却没显示「换线路」')
  }

  section('7. 点剧集按键 → 播放直链')
  const epData = epDatas.find((d) => d.startsWith('ep:'))
  if (!epData) {
    bad('没有选集按键')
  } else {
    const epReply = await buttons.ep({ ctx, buttonData: epData })
    const epText = textOf(epReply)
    if (epText.includes('.m3u8') || epText.includes('.mp4')) ok('拿到播放直链', epText.split('\n').find((l) => l.includes('.m3u8') || l.includes('.mp4'))?.slice(0, 90))
    else bad('选集后没有直链', epText.slice(0, 300))
    if (epText.includes('watch.html?url=')) ok('同时给了一起看链接')
    else bad('没有一起看链接')

    const playLabels = keyboardLabels(epReply)
    const playDatas = keyboardData(epReply)
    const pmissing = [...new Set(playDatas.map((d) => d.split(':')[0]))].filter((k) => !Object.keys(buttons).includes(k))
    if (pmissing.length === 0) ok('播放页按键的处理器都存在', playLabels.join(' '))
    else bad('播放页按键指向不存在的处理器', pmissing.join('、'))

    section('8. 「一起看」按键（复用会话里的直链，不请求站点）')
    const yqtData = playDatas.find((d, i) => playLabels[i] === '一起看')
    if (yqtData) {
      const yqtReply = await buttons.yqt({ ctx, buttonData: yqtData })
      const yqtText = textOf(yqtReply)
      if (yqtText.includes('watch.html?url=')) ok('一起看链接已生成')
      else bad('一起看链接异常', yqtText.slice(0, 200))
    } else bad('播放页没有「一起看」按键')

    section('9. 「最新一集」按键')
    const latestData = playDatas.find((d, i) => playLabels[i] === '最新一集')
    if (latestData) {
      const latestReply = await buttons.latest({ ctx, buttonData: latestData })
      const latestText = textOf(latestReply)
      const m = /· (第\d+集)/.exec(latestText)
      if (latestText.includes('.m3u8') || latestText.includes('.mp4')) ok('最新一集拿到直链', m?.[1] ?? '')
      else bad('最新一集没有直链', latestText.slice(0, 200))
    } else bad('播放页没有「最新一集」按键')
  }

  section('10. 一步到位 /看剧 <片名> <集数>')
  const oneShot = await runCommand('看剧', '斗罗大陆 5', newCtx())
  const oneText = textOf(oneShot)
  if (oneText.includes('.m3u8') || oneText.includes('.mp4')) ok('一步到位拿到直链', oneText.split('\n')[0])
  else bad('一步到位失败', oneText.slice(0, 300))
}

section('11. 会话过期提示')
{
  const c = newCtx()
  const reply = await buttons.pick({ ctx: c, buttonData: 'pick:nosuch:0' })
  if (textOf(reply).includes('会话已过期')) ok('过期会话有明确提示')
  else bad('过期会话提示不明确')
}

section('12. 一起看命令的参数校验')
{
  const bad1 = textOf(await runCommand('一起看', '不是链接'))
  if (bad1.includes('http(s) 直链')) ok('拒绝非链接参数')
  else bad('没有拒绝非法参数', bad1.slice(0, 120))
}

section('13. 反爬状态命令')
{
  const reply = await runCommand('看剧 状态', '', newCtx())
  const text = textOf(reply)
  if (text.includes('凭证状态')) ok('状态命令可用', text.split('\n')[2] ?? '')
  else bad('状态命令异常', text.slice(0, 200))
}

section('14. 入群欢迎语')
{
  const events = mod.default.events
  const reply = events['qq.group.robot_added']({ ctx: newCtx() })
  if (textOf(reply).includes('/看剧')) ok('欢迎语带用法')
  else bad('欢迎语异常')
}

console.log(`\n${'='.repeat(50)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail > 0 ? 1 : 0)
