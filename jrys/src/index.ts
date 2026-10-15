import { definePlugin, mentionedUsers, qqAt } from '@qqbot/sdk'

/** 与 configSchema 对应；面板保存的配置通过 ctx.config 注入（缺的字段回落 defaultConfig） */
export interface Config {
  /** 「今天」按哪个时区算：北京时间填 8，UTC 填 0 */
  timezoneOffset: number
  /** 帮别人看时要不要 @ 对方 */
  atTarget: boolean
}

const DEFAULT_TIMEZONE_OFFSET = 8

/** 抽到的运势；这就是回复里那四行，也是写进 D1 的那一行 */
export interface Fortune {
  level: string
  description: string
  luckyNumber: number
  luckyColor: string
}

/**
 * 等级与档位。`upTo` 是累计上界：roll 出 0-99 后取第一个 `roll < upTo` 的档，
 * 于是各档概率就是差值本身（大吉 5%、中吉 15%、小吉 20%、吉 30%、末吉 20%、凶 10%）。
 */
const LEVELS: ReadonlyArray<{ label: string; upTo: number; lines: readonly string[] }> = [
  {
    label: '大吉',
    upTo: 5,
    lines: [
      '状态好得不像话，想做的事今天就动手，开了头就顺。',
      '今天手气在最高点，要紧的事排上午，越早越顺。',
      '想说的话有人愿意听，想办的事有人愿意帮。',
      '不必挑日子，今天就是好日子，放心往前走。',
    ],
  },
  {
    label: '中吉',
    upTo: 20,
    lines: [
      '比预想的顺利，别自己给自己设限。',
      '手边的事都往好的方向走，稳住节奏就行。',
      '有机会也有余力，把力气花在真正在意的事上。',
      '适合把话说清楚，对方比你想的更好说话。',
    ],
  },
  {
    label: '小吉',
    upTo: 40,
    lines: [
      '小运气不断，攒着攒着就成了好事。',
      '动正事之前先理一遍清单，效率会高很多。',
      '适合把拖了很久的小事收尾，做完心里会很轻。',
      '不急着要结果，慢慢来反而更快。',
    ],
  },
  {
    label: '吉',
    upTo: 70,
    lines: [
      '平平常常的一天，把该做的做了就是赢。',
      '按计划走，不出错就是最好的结果。',
      '今天是打地基的日子，别嫌慢。',
      '该来的会来，先把手上这一件事做扎实。',
    ],
  },
  {
    label: '末吉',
    upTo: 90,
    lines: [
      '先紧后松，上午多留点余量，下午就从容了。',
      '宜少说多做，尤其别在群里较真。',
      '小事容易绊人，出门前多看一眼清单。',
      '慢一点没关系，别在同一个坑里踩两次。',
    ],
  },
  {
    label: '凶',
    upTo: 100,
    lines: [
      '诸事不宜硬刚，能推的会就推，能少的嘴就少。',
      '适合闭嘴做事，说话前先想三秒。',
      '别碰要签字和转账的事，明天再看。',
      '状态不在线就别硬撑，早点休息，明天再来。',
    ],
  },
]

const LUCKY_COLORS: readonly string[] = [
  '赤红',
  '杏黄',
  '松绿',
  '天青',
  '靛蓝',
  '藕荷',
  '月白',
  '琥珀',
  '珊瑚粉',
  '松烟墨',
]

/**
 * FNV-1a 32 位散列。只用来把「用户 + 日期」压成一个种子——同一输入永远同一个种子，
 * 这是「同一个人同一天结果一样」的全部依据，不涉及密码学，也不吃 CPU（几十次循环）。
 */
function hashSeed(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * xorshift32：从一个种子推出几个互不相关的数。
 * 不写成「种子 % 档数」连取，是因为那样相邻档位会高度相关（等级定了数字就跟着定）。
 */
function createRoll(seed: number): () => number {
  let state = seed || 0x9e3779b9
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state
  }
}

function levelFor(pick: number): (typeof LEVELS)[number] {
  for (const level of LEVELS) {
    if (pick < level.upTo) return level
  }
  return LEVELS[LEVELS.length - 1]!
}

/**
 * 某人在某天的运势。**纯函数**：同一个 `userId + day` 永远得到同一份结果，换一天就换一份——
 * 这是「今天不变、明天再算」的算法层保证，D1 里那行只是存档。
 */
export function drawFortune(userId: string, day: string): Fortune {
  const roll = createRoll(hashSeed(`${userId}|${day}`))
  const level = levelFor(roll() % 100)
  return {
    level: level.label,
    description: level.lines[roll() % level.lines.length]!,
    luckyNumber: (roll() % 99) + 1,
    luckyColor: LUCKY_COLORS[roll() % LUCKY_COLORS.length]!,
  }
}

/**
 * 把时间戳折算成目标时区的 `YYYY-MM-DD`。
 * Worker 的本地时间是 UTC，所以「今天」必须自己按偏移量算——否则北京时间 0-8 点发出的
 * 运势会算成前一天，日界跟群友对不上。
 */
export function dayKeyOf(nowMs: number, offsetHours: number): string {
  return new Date(nowMs + offsetHours * 3_600_000).toISOString().slice(0, 10)
}

/** 抽到的运势写成回复文本；`headline` 是给人看的主体（自己就是「今日运势」） */
function formatReply(day: string, headline: string, fortune: Fortune): string {
  return [
    `${headline} · ${day}`,
    `等级：${fortune.level}`,
    `运势：${fortune.description}`,
    `幸运数字：${fortune.luckyNumber}`,
    `幸运颜色：${fortune.luckyColor}`,
  ].join('\n')
}

/**
 * 表头那行：自己的就写「今日运势」，帮别人看的带上对方——
 * `atTarget` 打开时用 `qqAt` 真 @ 出来（openid 是群里那个，@ 本机器人的不算，见 mentionedUsers）。
 */
function headlineFor(mentioned: { id: string; username: string } | undefined, atTarget: boolean): string {
  if (!mentioned) return '今日运势'
  if (!atTarget) return `${mentioned.username || 'TA'} 的今日运势`
  return `${qqAt(mentioned.id)} 的今日运势`
}

// ---------------------------------------------------------------- D1

/** 只存「已经发出去的那份结果」，所以存的就是展示文本本身：以后改文案也不会把历史结果改掉 */
const SELECT_FORTUNE =
  'SELECT level, description, lucky_number, lucky_color FROM {fortune} WHERE user_id = ? AND day = ?'

const INSERT_FORTUNE =
  'INSERT OR IGNORE INTO {fortune} (user_id, day, user_name, target_id, level, description, lucky_number, lucky_color, drawn_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'

/** 建表走 exec（DDL，可多条）；带换行的值一律用 run 绑定参数写，exec 里不许出现 */
const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS {fortune} (
  user_id      TEXT    NOT NULL,
  day          TEXT    NOT NULL,
  user_name    TEXT    NOT NULL,
  target_id    TEXT    NOT NULL,
  level        TEXT    NOT NULL,
  description  TEXT    NOT NULL,
  lucky_number INTEGER NOT NULL,
  lucky_color  TEXT    NOT NULL,
  drawn_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
) WITHOUT ROWID;
`
// 不给 target_id / day 建索引：查询一律按主键 (user_id, day) 走，多一个索引只会让每次写入多算一行。
// WITHOUT ROWID 让主键就是表本身，写入算 1 行（TEXT 主键的普通表会额外多一个隐藏索引）。

interface FortuneRow {
  level: string
  description: string
  lucky_number: number
  lucky_color: string
}

const SCHEMA_KEY = 'schema'
const SCHEMA_VERSION = '1'

/** ensureSchema 只用到这两个能力，收窄参数就不用把整个 PluginContext 拖进来 */
interface SchemaCtx {
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> }
  db: { exec(sql: string): Promise<void> }
}

/**
 * 建表，幂等。KV 里的版本标记让它跨部署、跨冷启动只跑一次：
 * 以后要改表结构，把 SCHEMA_VERSION 抬一级，再把迁移写在这个判断后面。
 */
async function ensureSchema(ctx: SchemaCtx): Promise<void> {
  if ((await ctx.kv.get(SCHEMA_KEY)) === SCHEMA_VERSION) return
  await ctx.db.exec(CREATE_TABLE)
  await ctx.kv.put(SCHEMA_KEY, SCHEMA_VERSION)
}

export default definePlugin<Config>({
  // 包名 qflarebot-plugin-jrys 去掉前缀的短名；同时是 KV 前缀、D1 表前缀与路由 /p/jrys/ 前缀
  name: 'jrys',
  // 用了 SDK 导出的 mentionedUsers()，所以至少要 3（老机器人上没有这个导出，构建会失败）
  apiVersion: 3,
  displayName: '今日运势',
  description: '群里发 /jrys 看今天的运势，支持 @ 群友帮看',
  // 仅安装前展示，运行时不强制：db 存结果，kv 存建表标记
  permissions: ['db', 'kv'],

  configSchema: {
    type: 'object',
    properties: {
      timezoneOffset: {
        type: 'number',
        title: '日期时区（UTC 偏移小时）',
        description: '决定「今天」从几点开始。北京时间填 `8`，UTC 填 `0`。',
        default: DEFAULT_TIMEZONE_OFFSET,
        minimum: -12,
        maximum: 14,
      },
      atTarget: {
        type: 'boolean',
        title: '帮别人看时 @ 对方',
        description: '关掉就只写名字，不 @ 人。',
        default: true,
      },
    },
    required: ['timezoneOffset', 'atTarget'],
  },
  defaultConfig: { timezoneOffset: DEFAULT_TIMEZONE_OFFSET, atTarget: true },

  hooks: {
    // 首次安装后第一次运行，必须幂等
    async onInstall(ctx) {
      await ensureSchema(ctx)
    },
    // 自愈：onInstall 那次建表失败过、或表被人手工清掉时，这里会重新建一次（标记在时只是一次 KV 读）
    async onBoot(ctx) {
      await ensureSchema(ctx)
    },
  },

  commands: {
    jrys: {
      description: '查看今日运势',
      usage: '/jrys [@群友]',
      aliases: ['运势'],
      handler: async ({ ctx, session, argText }) => {
        // @ 的人可能只在正文里（没开全量消息的群），mentionedUsers 两边都看；机器人自己不算
        const mentioned = mentionedUsers(session)[0]
        // 写了参数却没 @ 到人：说清楚怎么用，别默默按发起人算
        if (!mentioned && argText) return '想看谁的运势，@ 他一下就行，例如 /jrys @群友'

        const target = mentioned ?? { id: session.userId, username: session.userName }

        const offset = Number.isFinite(ctx.config?.timezoneOffset)
          ? ctx.config.timezoneOffset
          : DEFAULT_TIMEZONE_OFFSET
        const day = dayKeyOf(Date.now(), offset)

        // 先读：今天已经抽过就原样返回那一行，不再写（同一人一天最多写一行）
        const row = await ctx.db.first<FortuneRow>(SELECT_FORTUNE, target.id, day)
        const fortune: Fortune = row
          ? {
              level: row.level,
              description: row.description,
              luckyNumber: row.lucky_number,
              luckyColor: row.lucky_color,
            }
          : await drawAndStore(ctx, session.targetId, target, day)

        const headline = headlineFor(mentioned, ctx.config?.atTarget !== false)
        return formatReply(day, headline, fortune)
      },
    },
  },
})

/** 抽一份并落库；INSERT OR IGNORE 让并发抢先写入也无害——同一人同一天算出来的本来就是同一份 */
async function drawAndStore(
  ctx: { db: { run(sql: string, ...params: unknown[]): Promise<{ changes: number }> } },
  targetId: string,
  target: { id: string; username: string },
  day: string,
): Promise<Fortune> {
  const fortune = drawFortune(target.id, day)
  await ctx.db.run(
    INSERT_FORTUNE,
    target.id,
    day,
    target.username,
    targetId,
    fortune.level,
    fortune.description,
    fortune.luckyNumber,
    fortune.luckyColor,
    Date.now(),
  )
  return fortune
}
