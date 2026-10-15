import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { meetsPermission, normalizePlugin, type DBBatchResult, type DBStatement, type ScopedDB } from '@qqbot/sdk'
import { createMockContext, runCommand, type MockSessionOptions } from '@qqbot/sdk/testing'
import { scopeSql, tablePrefix } from '@qqbot/sdk/sqlScope'
import plugin, { type Config } from './index.js'

const PLUGIN = 'demo'

/**
 * D1 替身：真 SQL 跑在 node:sqlite 上。
 *
 * 离线环境没有 D1，但 D1 的计费口径（**按改动的行数**，删除也算，索引再多算一行）本地能复现，
 * 所以这里把每条写语句的 `changes` 累加起来——「重复签到没写库」这类结论必须由它来证，不能只看回复文案。
 * 替身只实现插件用到的写法：SELECT 走 all()、写语句走 run()，别的 SQL 会直接在 sqlite 那里报错，
 * 不会静默通过；batch 照线上做成一个事务，逐条返回 { changes, results }。
 */
interface TestDb extends ScopedDB {
  /** 累计改动的行数 = D1 计费的行数（这张表没有二级索引，WITHOUT ROWID 也没有隐藏索引那一行） */
  readonly writes: number
  /** 发过去的语句条数（含 SELECT 与 DDL）；线上一次 batch 只算 1 个子请求，替身看不到这一点 */
  readonly queries: number
  reset(): void
  /** 造前置状态 / 查原始行用；{表名} 同样会展开 */
  raw(sql: string, ...params: unknown[]): Array<Record<string, unknown>>
}

function createTestDb(): TestDb {
  const db = new DatabaseSync(':memory:')
  const prefix = tablePrefix(PLUGIN)
  // createMockContext 只拿 SQL 去检查、把原样的 {表名} 交给替身，所以展开这一步得替身自己做（同一套规则）
  const expand = (sql: string): string => scopeSql(sql, prefix)
  const bind = (params: unknown[]): SQLInputValue[] => params as SQLInputValue[]
  let writes = 0
  let queries = 0

  const write = (sql: string, params: unknown[]): { changes: number } => {
    queries++
    const changes = Number(db.prepare(expand(sql)).run(...bind(params)).changes ?? 0)
    writes += changes
    return { changes }
  }

  return {
    get writes() {
      return writes
    },
    get queries() {
      return queries
    },
    reset() {
      writes = 0
      queries = 0
    },
    raw(sql, ...params) {
      if (/^\s*(?:SELECT|WITH)/i.test(sql)) {
        queries++
        return db.prepare(expand(sql)).all(...bind(params))
      }
      write(sql, params)
      return []
    },
    table: (name) => prefix + name,
    async exec(sql) {
      queries++
      db.exec(expand(sql))
    },
    async run(sql, ...params) {
      return write(sql, params)
    },
    async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      queries++
      return db.prepare(expand(sql)).all(...bind(params)) as T[]
    },
    async first<T>(sql: string, ...params: unknown[]): Promise<T | null> {
      queries++
      return (db.prepare(expand(sql)).get(...bind(params)) as T | undefined) ?? null
    },
    async batch<T>(statements: readonly DBStatement[]): Promise<Array<DBBatchResult<T>>> {
      if (!statements.length) return []
      const out: Array<DBBatchResult<T>> = []
      db.exec('BEGIN')
      try {
        for (const statement of statements) {
          if (/^\s*(?:SELECT|WITH)/i.test(statement.sql)) {
            queries++
            const rows = db.prepare(expand(statement.sql)).all(...bind(statement.params ?? [])) as T[]
            out.push({ changes: 0, results: rows })
          } else {
            out.push({ changes: write(statement.sql, statement.params ?? []).changes, results: [] })
          }
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      return out
    },
  }
}

/** 建表（按运行时 ensureReady 的顺序：onInstall → onBoot），并把计数清零，让后续断言只统计这一次调用 */
async function boot(): Promise<TestDb> {
  const db = createTestDb()
  const ctx = createMockContext(plugin, { db })
  await plugin.hooks!.onInstall!(ctx)
  await plugin.hooks!.onBoot!(ctx)
  db.reset()
  return db
}

/** 某个用户在某群的会话 */
function who(userId: string, name: string, targetId = 'g1'): MockSessionOptions {
  return { userId, userName: name, targetId }
}

/** 与插件同一套算法：读出来的日期减一天，避免测试自己算的日期和处理器跨了日界 */
function prevDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
}

function storedDay(db: TestDb, userId: string): string {
  const [row] = db.raw('SELECT day FROM {signs} WHERE group_id = ? AND user_id = ?', 'g1', userId)
  return String(row?.day)
}

describe('原有命令没被动过', () => {
  it('hello / count 照旧', async () => {
    expect((await runCommand(plugin, 'hello')).replies).toEqual(['你好，朋友'])
    expect((await runCommand(plugin, 'count', '2')).replies).toEqual(['1', '2'])
  })
})

describe('建表', () => {
  it('onInstall 建表，紧跟其后的 onBoot 看到 KV 标记就不再碰 D1', async () => {
    const db = createTestDb()
    const ctx = createMockContext(plugin, { db })
    await plugin.hooks!.onInstall!(ctx)
    expect(db.queries).toBe(1)
    db.reset()
    await plugin.hooks!.onBoot!(ctx)
    expect(db.queries).toBe(0)
  })

  it('升级路径：标记丢了（onInstall 不会跑）时 onBoot 自己把表建回来，且只建一次', async () => {
    const db = createTestDb()
    const ctx = createMockContext(plugin, { db })
    await plugin.hooks!.onBoot!(ctx)
    expect(db.queries).toBe(1)
    db.reset()
    await plugin.hooks!.onBoot!(ctx)
    expect(db.queries).toBe(0)
  })

  it('建表不只放在 onInstall —— 升级不触发任何钩子，那条路会漏掉表', () => {
    // 装过一次的机器人上 onInstall 的「装过」标记还在、不会再跑，只有 onBoot 每次冷启动都会走
    expect(plugin.hooks?.onInstall).toBeTypeOf('function')
    expect(plugin.hooks?.onBoot).toBeTypeOf('function')
  })
})

describe('/sign', () => {
  it('首次签到：给积分、连续 1 天，只改 1 行', async () => {
    const db = await boot()
    const session = await runCommand(plugin, 'sign', '', { ctx: { db }, session: who('u1', '小明') })
    expect(session.replies).toEqual(['签到成功！+10 积分，连续签到 1 天，当前 10 分'])
    // WITHOUT ROWID + 复合主键：插入一行就算 1 行，没有隐藏索引那一行
    expect(db.writes).toBe(1)
  })

  it('同一天重复签到：提示已签过 + 连续天数，0 行写入', async () => {
    const db = await boot()
    const options = { ctx: { db }, session: who('u1', '小明') }
    await runCommand(plugin, 'sign', '', options)
    db.reset()
    const again = await runCommand(plugin, 'sign', '', options)
    expect(again.replies).toEqual(['今天已经签到过了，连续签到 1 天，当前 10 分'])
    // WHERE {signs}.day <> excluded.day 不成立 → 一行没改，D1 计 0 行
    expect(db.writes).toBe(0)
    // 读和写合在一次 batch 里：2 条语句，1 个子请求
    expect(db.queries).toBe(2)
  })

  it('隔天再签：连续 +1', async () => {
    const db = await boot()
    const options = { ctx: { db }, session: who('u1', '小明') }
    await runCommand(plugin, 'sign', '', options)
    db.raw('UPDATE {signs} SET day = ? WHERE group_id = ? AND user_id = ?', prevDay(storedDay(db, 'u1')), 'g1', 'u1')
    db.reset()
    const session = await runCommand(plugin, 'sign', '', options)
    expect(session.replies).toEqual(['签到成功！+10 积分，连续签到 2 天，当前 20 分'])
    expect(db.writes).toBe(1)
  })

  it('断签一天：连续重置为 1', async () => {
    const db = await boot()
    const options = { ctx: { db }, session: who('u1', '小明') }
    await runCommand(plugin, 'sign', '', options)
    const twoDaysAgo = prevDay(prevDay(storedDay(db, 'u1')))
    db.raw('UPDATE {signs} SET day = ? WHERE group_id = ? AND user_id = ?', twoDaysAgo, 'g1', 'u1')
    db.reset()
    const session = await runCommand(plugin, 'sign', '', options)
    expect(session.replies).toEqual(['签到成功！+10 积分，连续签到 1 天，当前 20 分'])
    expect(db.writes).toBe(1)
  })

  it('积分在 SQL 里累加：库里已有更多分时不会覆盖回旧值', async () => {
    const db = await boot()
    const options = { ctx: { db }, session: who('u1', '小明') }
    await runCommand(plugin, 'sign', '', options)
    // 模拟「别的 isolate 刚加过积分」：day 仍是昨天（本次签到的前置状态），points 已经 +100
    db.raw(
      'UPDATE {signs} SET day = ?, points = points + 100 WHERE group_id = ? AND user_id = ?',
      prevDay(storedDay(db, 'u1')),
      'g1',
      'u1',
    )
    db.reset()
    const session = await runCommand(plugin, 'sign', '', options)
    expect(session.replies).toEqual(['签到成功！+10 积分，连续签到 2 天，当前 120 分'])
    const points = await runCommand(plugin, 'points', '', options)
    expect(points.replies).toEqual(['积分 120，连续签到 2 天，累计 2 次（今天已签到）'])
  })

  it('别名 /签到 命中同一条命令', async () => {
    const db = await boot()
    const session = await runCommand(plugin, '签到', '', { ctx: { db }, session: who('u1', '小明') })
    expect(session.replies).toEqual(['签到成功！+10 积分，连续签到 1 天，当前 10 分'])
  })

  it('每次签到的积分按面板配置走', async () => {
    const db = await boot()
    const config: Config = { greeting: '你好', pointsPerSign: 25, utcOffset: 8 }
    const session = await runCommand(plugin, 'sign', '', { ctx: { db, config }, session: who('u1', '小明') })
    expect(session.replies).toEqual(['签到成功！+25 积分，连续签到 1 天，当前 25 分'])
  })

  it('时区偏移决定「今天」是哪一天', async () => {
    const db = await boot()
    const config: Config = { greeting: '你好', pointsPerSign: 10, utcOffset: -12 }
    await runCommand(plugin, 'sign', '', { ctx: { db, config }, session: who('u1', '小明') })
    const expected = new Date(Date.now() - 12 * 3_600_000).toISOString().slice(0, 10)
    expect(storedDay(db, 'u1')).toBe(expected)
  })
})

describe('/points', () => {
  it('没签过：提示去签，不写库', async () => {
    const db = await boot()
    const session = await runCommand(plugin, 'points', '', { ctx: { db }, session: who('u1', '小明') })
    expect(session.replies).toEqual(['还没有签到记录，发 /sign 签到'])
    expect(db.writes).toBe(0)
  })

  it('签过：积分 / 连续天数 / 累计次数 / 今日状态，不写库', async () => {
    const db = await boot()
    const options = { ctx: { db }, session: who('u1', '小明') }
    await runCommand(plugin, 'sign', '', options)
    db.reset()
    const session = await runCommand(plugin, 'points', '', options)
    expect(session.replies).toEqual(['积分 10，连续签到 1 天，累计 1 次（今天已签到）'])
    expect(db.writes).toBe(0)
    expect(db.queries).toBe(1)
  })
})

describe('/rank', () => {
  it('按积分倒序取前 10，纯读', async () => {
    const db = await boot()
    for (let i = 1; i <= 12; i++) {
      db.raw(
        'INSERT INTO {signs} (group_id, user_id, name, day, streak, points, total) VALUES (?, ?, ?, ?, ?, ?, ?)',
        'g1',
        `u${i}`,
        `成员${i}`,
        storedDay(db, 'u1') || '2026-01-01',
        1,
        i * 10,
        1,
      )
    }
    db.reset()
    const session = await runCommand(plugin, 'rank', '', { ctx: { db }, session: { targetId: 'g1' } })
    const lines = String(session.replies[0]).split('\n')
    expect(lines[0]).toBe('本群积分榜')
    expect(lines).toHaveLength(11) // 标题 + 前 10 名
    expect(lines[1]).toBe('1. 成员12 120 分')
    expect(lines[10]).toBe('10. 成员3 30 分')
    expect(db.writes).toBe(0)
    expect(db.queries).toBe(1)
  })

  it('本群没人签过：给个引导', async () => {
    const db = await boot()
    const session = await runCommand(plugin, 'rank', '', { ctx: { db }, session: { targetId: 'g1' } })
    expect(session.replies).toEqual(['本群还没有人签到，发 /sign 抢第一'])
    expect(db.writes).toBe(0)
  })

  it('单聊里不装群榜，也不查库', async () => {
    const db = await boot()
    const session = await runCommand(plugin, 'rank', '', { ctx: { db }, session: { scene: 'c2c', targetId: 'u1' } })
    expect(session.replies).toEqual(['排行榜要在群里看'])
    expect(db.queries).toBe(0)
  })

  it('各群的积分互不可见', async () => {
    const db = await boot()
    await runCommand(plugin, 'sign', '', { ctx: { db }, session: who('u1', '小明', 'g1') })
    const other = await runCommand(plugin, 'rank', '', { ctx: { db }, session: { targetId: 'g2' } })
    expect(other.replies).toEqual(['本群还没有人签到，发 /sign 抢第一'])
  })
})

describe('/sign reset（群管理员）', () => {
  // 运行时 content 里的 <@openid> 已被去掉，也被 @ 的人只在 mentions / 原始正文里，
  // 所以这里按线上的形状给 session：content 是 '/sign reset'，@ 的人走 mentions
  const admin = (mentions: MockSessionOptions['mentions'] = []): MockSessionOptions => ({
    ...who('admin', '群主'),
    content: '/sign reset',
    mentions,
  })

  it('清掉被 @ 的人的记录：DELETE 也算 1 行写入，之后可以重新签', async () => {
    const db = await boot()
    await runCommand(plugin, 'sign', '', { ctx: { db }, session: who('u2', '小明') })
    db.reset()
    const session = await runCommand(plugin, 'sign reset', '@u2', {
      ctx: { db },
      session: admin([{ id: 'u2', username: '小明', bot: false }]),
    })
    expect(session.replies).toEqual(['已清掉 <@u2> 的签到记录'])
    expect(db.writes).toBe(1)
    const again = await runCommand(plugin, 'sign', '', { ctx: { db }, session: who('u2', '小明') })
    expect(again.replies).toEqual(['签到成功！+10 积分，连续签到 1 天，当前 10 分'])
  })

  it('没有记录：说一声，不写库', async () => {
    const db = await boot()
    const session = await runCommand(plugin, 'sign reset', '@u9', {
      ctx: { db },
      session: admin([{ id: 'u9', username: '路人', bot: false }]),
    })
    expect(session.replies).toEqual(['路人 还没有签到记录'])
    expect(db.writes).toBe(0)
  })

  it('没 @ 人：给用法，不写库', async () => {
    const db = await boot()
    const session = await runCommand(plugin, 'sign reset', '', { ctx: { db }, session: admin() })
    expect(session.replies).toEqual(['用法：/sign reset @某人'])
    expect(db.writes).toBe(0)
  })

  it('别名 /签到 reset @某人 也能用（别名不会自动组合，子命令得自己再写一条）', async () => {
    const db = await boot()
    await runCommand(plugin, 'sign', '', { ctx: { db }, session: who('u2', '小明') })
    const session = await runCommand(plugin, '签到 reset', '@u2', {
      ctx: { db },
      session: admin([{ id: 'u2', username: '小明', bot: false }]),
    })
    expect(session.replies).toEqual(['已清掉 <@u2> 的签到记录'])
  })

  it('门槛声明在命令上：group_admin（达标制，不达标在匹配阶段就被静默跳过）', () => {
    const cmd = normalizePlugin(plugin).commands.find((c) => c.name === 'sign reset')
    expect(cmd?.permission).toBe('group_admin')
    // 普通成员不过；群主、群管理员、Bot 管理员都过（单聊没有群角色，只有 Bot 管理员过得去）
    expect(meetsPermission({ isBotAdmin: false, memberRole: 'member' }, 'group_admin')).toBe(false)
    expect(meetsPermission({ isBotAdmin: false, memberRole: 'owner' }, 'group_admin')).toBe(true)
    expect(meetsPermission({ isBotAdmin: false, memberRole: 'admin' }, 'group_admin')).toBe(true)
    expect(meetsPermission({ isBotAdmin: true, memberRole: undefined }, 'group_admin')).toBe(true)
  })

  // runCommand 直接调处理器、不过 permission 门槛（sdk/testing.ts），所以拦截行为用上面那条「声明 + meetsPermission」
  // 来验；真实的「普通成员发 /sign reset 没有任何回复」只能在机器人上验
})

describe('清单契约', () => {
  it('apiVersion 抬到 3（用了 batch 与 mentionedUsers）', () => {
    expect(plugin.apiVersion).toBe(3)
  })

  it('命令名与别名不重复，且都塞得进 QQ 指令面板（显示宽度 ≤14）', () => {
    const width = (s: string) => [...s].reduce((n, ch) => n + (ch.codePointAt(0)! <= 0x7f ? 1 : 2), 0)
    const commands = normalizePlugin(plugin).commands
    const keys = commands
      .flatMap((c) => [c.name, ...(c.aliases ?? [])])
      .map((n) => n.trim().toLowerCase().replace(/\s+/g, ' '))
    expect(new Set(keys).size).toBe(keys.length)
    for (const name of keys) expect(width(name)).toBeLessThanOrEqual(14)
  })
})
