import { definePlugin, mentionedUsers, qqAt } from '@qqbot/sdk'

/** 与 configSchema 对应；面板保存的配置通过 ctx.config 注入（缺的字段回落 defaultConfig） */
export interface Config {
  greeting: string
  /** 每次签到给多少积分 */
  pointsPerSign: number
  /** 签到日按 UTC+该值 算（默认 8，即北京时间 0 点换日） */
  utcOffset: number
}

/** 建表标记的 KV 键；一份 schema 只建一次表，见 onBoot */
const SCHEMA_KEY = 'schema'
const SCHEMA_VERSION = 'signs-1'

/**
 * 签到表的列。一个「群 + 人」一行，签到只改这一行——写入次数跟消息数无关，
 * 一人一天最多写 1 行（重复签到是 0 行，见 sign 的 UPSERT）。
 */
interface SignRow {
  user_id: string
  name: string
  /** UTC+utcOffset 下的日期，YYYY-MM-DD；连续签到的判断只看它 */
  day: string
  streak: number
  points: number
  total: number
}

/** UTC+offset 的「今天」，如 2026-10-15 */
function dayOf(ts: number, utcOffset: number): string {
  return new Date(ts + utcOffset * 3_600_000).toISOString().slice(0, 10)
}

/** day 的前一天：按日期字符串算，不再碰时区 */
function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
}

/** 面板里可能存进非数字，兜一下底；12 小时进不了 10 ms CPU 预算，顺手也算不上负担 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 展示名：优先最近一次签到记下的群昵称，取不到就露 openid 尾巴，别把 32 位 openid 整条打出来 */
function label(userId: string, name: string): string {
  return name || `…${userId.slice(-6)}`
}

/**
 * 建表语句（onInstall 与 onBoot 共用，幂等）。
 *
 * - 主键 (group_id, user_id) + `WITHOUT ROWID`：主键就是整张表，没有 SQLite 给 TEXT 主键
 *   自动加的那个隐藏索引，插入一行就只算 1 行写入；
 * - 不为 points 建索引：索引会让每次签到多算 1 行写入，而 /rank 是低频纯读（读 500 万行/天，是写的 50 倍）。
 *   真出现排行热点再加 `CREATE INDEX {signs_rank} ON {signs}(group_id, points DESC)`。
 */
const CREATE_SIGNS = `CREATE TABLE IF NOT EXISTS {signs} (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  day TEXT NOT NULL,
  streak INTEGER NOT NULL,
  points INTEGER NOT NULL,
  total INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
) WITHOUT ROWID`

export default definePlugin<Config>({
  // 包名 qflarebot-plugin-demo 去掉前缀的短名；构建时校验与 package.json 对得上。
  // 它同时是 KV 前缀、D1 表前缀与路由 /p/demo/ 前缀
  name: 'demo',
  // 最低要求的契约版本。3：用到了 mentionedUsers（SDK 导出的新函数，老机器人上没有这个导出）
  // 与 ctx.db.batch()（版本 2 起）；只读 session.isBotAdmin / session.quote 才不必写 3
  apiVersion: 3,
  displayName: '演示',
  description: '测试用插件',
  // 仅供安装前展示，运行时不强制（插件与核心同 isolate，没有沙箱）。
  // kv 用于 onBoot 的建表标记，db 用于签到数据
  permissions: ['kv', 'db'],

  configSchema: {
    type: 'object',
    properties: {
      greeting: { type: 'string', title: '问候语', default: '你好' },
      pointsPerSign: { type: 'integer', title: '每次签到积分', minimum: 1, maximum: 1000, default: 10 },
      utcOffset: {
        type: 'integer',
        title: '时区偏移（小时）',
        description: '签到日按 UTC+该值 计算，默认 8（北京时间 0 点换日）',
        minimum: -12,
        maximum: 14,
        default: 8,
      },
    },
    required: ['greeting'],
  },
  defaultConfig: { greeting: '你好', pointsPerSign: 10, utcOffset: 8 },

  hooks: {
    /** 首次安装后第一次运行：建表。幂等，且没有引号内换行（exec 会先把 SQL 压成一行） */
    async onInstall(ctx) {
      await ctx.db.exec(CREATE_SIGNS)
      // 顺手写下 schema 标记：紧接着的 onBoot 看到它就什么都不做，不必再建一遍
      await ctx.kv.put(SCHEMA_KEY, SCHEMA_VERSION)
    },

    /**
     * 升级不触发任何钩子（没有 onUpgrade），已经装过的机器人上 onInstall 的「装过」标记还在、
     * 不会再跑——所以表结构变化只能在 onBoot 里惰性补：KV 标记记的是建到第几版，
     * 同一个 isolate 冷启动时读一次（KV 读 10 万次/天，写只有 1,000 次/天），
     * 不命中才建表 + 写标记。CREATE 是幂等的，重复跑也不会坏。
     */
    async onBoot(ctx) {
      if ((await ctx.kv.get(SCHEMA_KEY)) === SCHEMA_VERSION) return
      await ctx.db.exec(CREATE_SIGNS)
      await ctx.kv.put(SCHEMA_KEY, SCHEMA_VERSION)
    },
  },

  commands: {
    // 最简形式：返回值就是回复（字符串或消息对象），返回 undefined 表示不回复
    hello: ({ ctx, argText }) => `${ctx.config.greeting}，${argText || '朋友'}`,

    // 要描述/别名/权限/子命令时用对象形式；async generator 可以连发多条（同一条消息的被动回复上限 5 条）
    count: {
      description: '数到 N',
      usage: '/count [N]',
      aliases: ['数数'],
      async *handler({ args }) {
        const n = Math.min(5, Number(args[0]) || 3)
        for (let i = 1; i <= n; i++) yield `${i}`
      },
    },

    /**
     * 每日签到。写入次数是这块的重点：
     *
     * - 一个「群 + 人」一行（`WITHOUT ROWID`，主键就是整行），一次签到最多改 1 行；
     * - 读和写合成一次 `batch`：一次往返、整批一个事务，整条命令只花 1 个子请求；
     * - 写语句带 `WHERE {signs}.day <> excluded.day`：今天签过就一行都不改（D1 按改动行数计费，
     *   0 行 = 0 行额度），于是「先读后写 + 重复签到不落库」两件事一次做完；
     * - points 在 SQL 里做 `points + excluded.points` 累加，不拿读到的旧值回写，
     *   并发下也不会把别人刚加的积分覆盖掉；用 `changes` 判断这次到底写没写进去。
     */
    sign: {
      description: '每日签到拿积分',
      usage: '/sign',
      aliases: ['签到'],
      handler: async ({ ctx, session }) => {
        const offset = clampInt(ctx.config.utcOffset, 8, -12, 14)
        const award = clampInt(ctx.config.pointsPerSign, 10, 1, 1000)
        const today = dayOf(Date.now(), offset)
        const yesterday = dayBefore(today)
        const groupId = session.targetId

        const [read, write] = await ctx.db.batch<SignRow>([
          {
            sql: 'SELECT day, streak, points, total FROM {signs} WHERE group_id = ? AND user_id = ?',
            params: [groupId, session.userId],
          },
          {
            sql: `INSERT INTO {signs} (group_id, user_id, name, day, streak, points, total)
                  VALUES (?, ?, ?, ?, 1, ?, 1)
                  ON CONFLICT (group_id, user_id) DO UPDATE SET
                    name = excluded.name,
                    streak = CASE WHEN {signs}.day = ? THEN {signs}.streak + 1 ELSE 1 END,
                    points = {signs}.points + excluded.points,
                    total = {signs}.total + 1,
                    day = excluded.day
                  WHERE {signs}.day <> excluded.day`,
            params: [groupId, session.userId, session.userName, today, award, yesterday],
          },
        ])

        const before = read?.results[0]
        // 0 行改动 = 今天已经签过（并发下两人同时签也是同一条：先写进去的那个算数）
        if (!write || write.changes === 0) {
          const streak = before?.streak ?? 1
          return `今天已经签到过了，连续签到 ${streak} 天，当前 ${before?.points ?? 0} 分`
        }
        const streak = before && before.day === yesterday ? before.streak + 1 : 1
        return `签到成功！+${award} 积分，连续签到 ${streak} 天，当前 ${(before?.points ?? 0) + award} 分`
      },
    },

    // 纯读：D1 读 500 万行/天，是写的 50 倍，这类命令不碰写入额度
    points: {
      description: '查看自己的积分',
      usage: '/points',
      aliases: ['积分'],
      handler: async ({ ctx, session }) => {
        const row = await ctx.db.first<SignRow>(
          'SELECT day, streak, points, total FROM {signs} WHERE group_id = ? AND user_id = ?',
          session.targetId,
          session.userId,
        )
        if (!row) return '还没有签到记录，发 /sign 签到'
        const today = dayOf(Date.now(), clampInt(ctx.config.utcOffset, 8, -12, 14))
        const todayText = row.day === today ? '今天已签到' : '今天还没签到'
        return `积分 ${row.points}，连续签到 ${row.streak} 天，累计 ${row.total} 次（${todayText}）`
      },
    },

    rank: {
      description: '本群积分排行榜',
      usage: '/rank',
      aliases: ['排行'],
      handler: async ({ ctx, session }) => {
        // 单聊里没有「本群」，一句话说清楚比返回只有自己的榜更好
        if (session.scene === 'c2c') return '排行榜要在群里看'
        // 表上没有 (group_id, points) 索引：它是纯读路径，扫本群几百行比让每次签到多写 1 行索引划算
        const rows = await ctx.db.all<SignRow>(
          'SELECT user_id, name, points FROM {signs} WHERE group_id = ? ORDER BY points DESC, user_id LIMIT 10',
          session.targetId,
        )
        if (!rows.length) return '本群还没有人签到，发 /sign 抢第一'
        const lines = rows.map((r, i) => `${i + 1}. ${label(r.user_id, r.name)} ${r.points} 分`)
        return `本群积分榜\n${lines.join('\n')}`
      },
    },

    /**
     * 子命令（名字带空格），权限走声明式门槛：不达标的调用在匹配阶段就被静默跳过，
     * 连处理器都不会跑——按钮回调那种带不上群角色的入口才需要在处理器里判 meetsPermission。
     * 只是清一行，用 run 就够了，不必 batch。
     */
    'sign reset': {
      description: '清掉某人的签到记录',
      usage: '/sign reset @某人',
      permission: 'group_admin',
      // 别名不会自动组合：父命令的别名要在子命令上再写一条，/签到 reset 才认
      aliases: ['签到 reset'],
      handler: async ({ ctx, session }) => {
        // content 里的 <@openid> 已被运行时去掉，@ 的人只能从 mentions / 原始正文里取
        const [target] = mentionedUsers(session)
        if (!target) return '用法：/sign reset @某人'
        const result = await ctx.db.run(
          'DELETE FROM {signs} WHERE group_id = ? AND user_id = ?',
          session.targetId,
          target.id,
        )
        return result.changes > 0
          ? `已清掉 ${qqAt(target.id)} 的签到记录`
          : `${label(target.id, target.username)} 还没有签到记录`
      },
    },
  },
})
