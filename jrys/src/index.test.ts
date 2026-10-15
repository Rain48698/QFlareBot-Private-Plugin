import { DatabaseSync } from 'node:sqlite'
import type { DBBatchResult, DBStatement, ScopedDB } from '@qqbot/sdk'
import { tablePrefix } from '@qqbot/sdk/sqlScope'
import { createMockContext, runCommand } from '@qqbot/sdk/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import plugin, { drawFortune, dayKeyOf, type Config } from './index.js'

const CONFIG: Config = { timezoneOffset: 8, atTarget: true }

/** 与运行时同一个前缀：直接用 SDK 里那个函数，别手抄一份规则 */
const PREFIX = tablePrefix(plugin.name)

/**
 * `ctx.db` 的替身：真的跑 SQLite（node:sqlite），只补上线上运行时做的那一步——把 `{表名}` 展开成 `p_jrys_表名`。
 * 建表语句、主键、列类型因此都被真的执行过，SQL 写错在本地就报，不用等装上机器人。
 * 测试替身由 SDK 的 createMockContext 先按线上规则查一遍表名（scopeSql），再原样交给这里。
 */
function createSqliteDb() {
  const raw = new DatabaseSync(':memory:')
  /** 收到的每条 SQL（未展开、未执行前记下），用来断言「写了几次」 */
  const log: string[] = []
  const expand = (sql: string) => sql.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, `${PREFIX}$1`)
  const prepare = (sql: string) => {
    log.push(sql)
    return raw.prepare(expand(sql))
  }
  const params = (list: unknown[]) => list as Array<string | number | null>

  const db: ScopedDB & {
    readonly log: string[]
    /** 收到过的、匹配这个模式的 SQL 条数（写入次数一类的断言用） */
    statements(pattern: RegExp): string[]
    tableStatements(): string[]
    inserts(): number
    tableNames(): string[]
    rows(): Array<Record<string, unknown>>
  } = {
    log,
    // @deprecated 的旧写法，线上固定返回前缀，这里照做
    table: (name) => PREFIX + name,
    async exec(sql) {
      log.push(sql)
      raw.exec(expand(sql))
    },
    async run(sql, ...rest) {
      const result = prepare(sql).run(...params(rest))
      return { changes: Number(result.changes) }
    },
    async all<T>(sql: string, ...rest: unknown[]) {
      return prepare(sql).all(...params(rest)) as T[]
    },
    async first<T>(sql: string, ...rest: unknown[]) {
      return (prepare(sql).get(...params(rest)) ?? null) as T | null
    },
    // 本插件没用到 batch；实现了才说明「省往返」那条路以后也能测
    async batch<T>(statements: readonly DBStatement[]): Promise<Array<DBBatchResult<T>>> {
      raw.exec('BEGIN')
      try {
        const out = statements.map((s) => {
          const stmt = prepare(s.sql)
          const bound = params(s.params ?? [])
          if (/^\s*(select|with)/i.test(s.sql)) return { changes: 0, results: stmt.all(...bound) as T[] }
          return { changes: Number(stmt.run(...bound).changes), results: [] as T[] }
        })
        raw.exec('COMMIT')
        return out
      } catch (err) {
        raw.exec('ROLLBACK')
        throw err
      }
    },
    statements: (pattern) => log.filter((s) => pattern.test(s)),
    tableStatements: () => log.filter((s) => /CREATE TABLE/i.test(s)),
    inserts: () => log.filter((s) => /^\s*INSERT/i.test(s)).length,
    tableNames: () =>
      (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    rows: () => raw.prepare('SELECT * FROM p_jrys_fortune ORDER BY user_id, day').all() as Array<Record<string, unknown>>,
  }
  return db
}

type MockDb = ReturnType<typeof createSqliteDb>

const options = (db: MockDb, config: Config = CONFIG) => ({ ctx: { config, db } })

/**
 * 建完表的库。线上的 dispatcher 保证「插件第一次被用到时先跑 onInstall」再进处理器
 * （见 runtime 的 ensureReady），测试也从同一个状态起步，否则测的是线上不会出现的「表还不存在」。
 */
async function installedDb(): Promise<MockDb> {
  const db = createSqliteDb()
  await plugin.hooks!.onInstall!(createMockContext(plugin, { config: CONFIG, db }))
  return db
}

describe('jrys 今日运势', () => {
  beforeEach(() => {
    // 固定「现在」：北京时间 2026-10-15 11:00（UTC 03:00），日期字段因此可预期
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('onInstall 建表幂等，KV 标记让它只跑一次', async () => {
    const db = createSqliteDb()
    const ctx = createMockContext(plugin, { config: CONFIG, db })
    await plugin.hooks!.onInstall!(ctx)
    expect(db.tableNames()).toEqual([`${PREFIX}fortune`])
    expect(db.tableStatements()).toHaveLength(1)

    // 标记已经写进 KV：冷启动的 onBoot 只读一次标记，不再建表
    await plugin.hooks!.onBoot!(ctx)
    expect(db.tableStatements()).toHaveLength(1)
    await expect(ctx.kv.get('schema')).resolves.toBe('1')
  })

  it('同一个人同一天：两次结果完全一样，且只写一行', async () => {
    const db = await installedDb()
    const first = await runCommand(plugin, 'jrys', '', options(db))
    const second = await runCommand(plugin, 'jrys', '', options(db))

    expect(first.replies).toHaveLength(1)
    expect(second.replies).toEqual(first.replies)
    // 第一次抽是「读一次 + 写一次」，第二次只读；同一人一天最多一行
    expect(db.inserts()).toBe(1)
    expect(db.rows()).toHaveLength(1)

    const text = String(first.replies[0])
    expect(text.split('\n')[0]).toBe('今日运势 · 2026-10-15')
    expect(text).toMatch(/等级：(大吉|中吉|小吉|吉|末吉|凶)/)
    expect(text).toMatch(/幸运数字：\d{1,2}/)
    expect(text).toMatch(/幸运颜色：\S+/)
  })

  it('别名 /运势 与 /jrys 是同一份结果', async () => {
    const db = await installedDb()
    const byName = await runCommand(plugin, 'jrys', '', options(db))
    const byAlias = await runCommand(plugin, '运势', '', options(db))
    expect(byAlias.replies).toEqual(byName.replies)
  })

  it('换一天就换一份结果', async () => {
    const db = await installedDb()
    let changed = 0
    for (let i = 0; i < 30; i++) {
      const user = { userId: `user-${i}` }
      vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
      const today = await runCommand(plugin, 'jrys', '', { session: user, ...options(db) })
      vi.setSystemTime(new Date('2026-10-16T03:00:00Z'))
      const tomorrow = await runCommand(plugin, 'jrys', '', { session: user, ...options(db) })
      if (today.replies[0] !== tomorrow.replies[0]) changed += 1
    }
    expect(changed).toBe(30)
    // 两天各有一行，谁都没被覆盖
    expect(db.rows()).toHaveLength(60)
  })

  it('日界按时区算：UTC+8 的 0 点前后属于两天', () => {
    const at = (iso: string) => dayKeyOf(Date.parse(iso), 8)
    expect(at('2026-10-15T15:59:59Z')).toBe('2026-10-15')
    expect(at('2026-10-15T16:00:00Z')).toBe('2026-10-16')
    // 时区可配：UTC 下同一个时刻是前一天
    expect(dayKeyOf(Date.parse('2026-10-15T16:00:00Z'), 0)).toBe('2026-10-15')
  })

  it('看不到 @ 的人时提示用法，别默默按发起人算', async () => {
    const db = await installedDb()
    const session = await runCommand(plugin, 'jrys', '张三', options(db))
    expect(String(session.replies[0])).toContain('/jrys @群友')
    // 一次库都没查（只有 onInstall 的那条建表）
    expect(db.statements(/select|insert/i)).toHaveLength(0)
  })

  it('@ 群友时看的是对方的运势，并且 @ 出来', async () => {
    const db = await installedDb()
    const other = { id: 'openid-zhangsan', username: '张三' }

    // 问的人自己抽一次，和「别人帮他抽」的结果必须一致
    const self = await runCommand(plugin, 'jrys', '', { session: { userId: other.id }, ...options(db) })
    const asked = await runCommand(plugin, 'jrys', '', {
      session: { userId: 'openid-asker', mentions: [{ id: other.id, username: other.username, bot: false }] },
      ...options(db),
    })

    const askedText = String(asked.replies[0])
    expect(askedText.startsWith(`<@${other.id}> 的今日运势 · 2026-10-15`)).toBe(true)
    // 去掉表头那行，四行内容与对方自己抽的完全一致
    expect(askedText.split('\n').slice(1)).toEqual(String(self.replies[0]).split('\n').slice(1))
    // 行记在被看的人名下，而不是发起人名下
    expect(db.rows().some((r) => r.user_id === other.id)).toBe(true)
    expect(db.rows().some((r) => r.user_id === 'openid-asker')).toBe(false)
  })

  it('关掉 atTarget 就只写名字', async () => {
    const db = await installedDb()
    const session = await runCommand(plugin, 'jrys', '', {
      session: { userId: 'openid-asker', mentions: [{ id: 'openid-lisi', username: '李四', bot: false }] },
      ...options(db, { ...CONFIG, atTarget: false }),
    })
    expect(String(session.replies[0]).startsWith('李四 的今日运势 · 2026-10-15')).toBe(true)
  })

  it('没开全量消息的群里，@ 只出现在正文里也认得出', async () => {
    const db = await installedDb()
    const session = await runCommand(plugin, 'jrys', '', {
      session: { userId: 'openid-asker', mentions: [], raw: { content: '/jrys <@openid-wangwu>' } },
      ...options(db),
    })
    expect(String(session.replies[0]).startsWith('<@openid-wangwu> 的今日运势')).toBe(true)
  })

  it('已经发过的结果就是最终结果：D1 里那行优先于重新抽', async () => {
    const db = await installedDb()
    await db.run(
      'INSERT INTO {fortune} (user_id, day, user_name, target_id, level, description, lucky_number, lucky_color, drawn_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'mock-user',
      '2026-10-15',
      '测试用户',
      'mock-group',
      '凶',
      '存档里的描述：今天什么都不顺。',
      4,
      '松烟墨',
      Date.parse('2026-10-15T03:00:00Z'),
    )

    const session = await runCommand(plugin, 'jrys', '', options(db))
    const text = String(session.replies[0])
    expect(text).toContain('等级：凶')
    expect(text).toContain('存档里的描述：今天什么都不顺。')
    expect(text).toContain('幸运数字：4')
    expect(text).toContain('幸运颜色：松烟墨')
    expect(db.inserts()).toBe(1) // 只有测试自己插的那一条
  })

  it('抽出来的结果落进 D1，等级与颜色都在允许的取值里', async () => {
    const db = await installedDb()
    await runCommand(plugin, 'jrys', '', options(db))
    const row = db.rows()[0]!
    expect(row).toMatchObject({ user_id: 'mock-user', day: '2026-10-15', user_name: '测试用户', target_id: 'mock-group' })
    expect(['大吉', '中吉', '小吉', '吉', '末吉', '凶']).toContain(row.level)
    expect(row.lucky_number).toBeGreaterThanOrEqual(1)
    expect(row.lucky_number).toBeLessThanOrEqual(99)
    expect(row.drawn_at).toBe(Date.parse('2026-10-15T03:00:00Z'))
  })

  it('纯函数层：同一个 userId + day 永远同一份，换天换人都会变，六档都能抽到', () => {
    const base = drawFortune('u1', '2026-10-15')
    expect(drawFortune('u1', '2026-10-15')).toEqual(base)
    expect(drawFortune('u1', '2026-10-16')).not.toEqual(base)
    expect(drawFortune('u2', '2026-10-15')).not.toEqual(base)

    // 六档都要能出现：最稀的大吉 5%，400 次里一次不出现的概率约 1e-9
    const hits = new Set<string>()
    for (let i = 0; i < 400; i++) hits.add(drawFortune(`u${i}`, '2026-10-15').level)
    expect([...hits].sort()).toEqual(['大吉', '中吉', '小吉', '吉', '末吉', '凶'].sort())
  })
})
