# QFlareBot 自用插件

给 [QFlareBot](https://github.com/QFlareBot/QFlareBot)（跑在 Cloudflare Workers 上的 QQ 官方机器人框架）写的插件。
**一个仓库放多个插件，每个插件一个子目录。**

| 目录 | 短名 | 包名 | 做什么 |
| --- | --- | --- | --- |
| `demo/` | `demo` | `qflarebot-plugin-demo` | `/hello`、`/count`、`/sign`（签到）、`/points`（积分）、`/rank`（排行）、`/sign reset`——**新插件照它抄** |
| `jrys/` | `jrys` | `qflarebot-plugin-jrys` | `/jrys [@群友]` 今日运势，同一人同一天结果固定，按 UTC+8 分日 |

> 仓库名里的 `Private` 只是个名字。**这个仓库必须保持 public**——面板安装插件时匿名读仓库里的 `manifest.json`，构建机也匿名下载源码，私有仓库两步都会 404。

---

# 给 AI agent：往这个仓库加一个插件

**这一节写给你（AI）看，用户把这个仓库地址丢过来就是要你照这里做完。读完这一节就够，不用先去研究 QFlareBot 是什么、插件怎么写。**

目标：在仓库里新增一个 `<短名>/` 目录 → 本地构建测试通过 → 推到 `main` → 把安装来源回报给用户。

## 0. 前置检查（缺什么补什么）

```bash
node -v                                              # 需要 >= 22
ls -d D:/code/QFlareBot/packages/sdk/src/index.ts    # QFlareBot 源码检出
ls -d D:/code/QFlareBot-Private-Plugin               # 本仓库检出
```

**两个仓库必须是同一个父目录**（这里是 `D:/code/`）。插件的 `devDependencies` 是 `file:../../QFlareBot/packages/*`——`@qqbot/sdk` 和 `@qqbot/plugin-cli` 都不发 npm，只能链接本地源码，层级对不上就装不上。

```bash
# 缺仓库就检出（目录名必须与命令里一致，devDependencies 的相对路径是按它写的）
git clone https://github.com/Rain48698/QFlareBot-Private-Plugin D:/code/QFlareBot-Private-Plugin
git clone https://github.com/QFlareBot/QFlareBot D:/code/QFlareBot

# QFlareBot 检出只需初始化一次。下面这条有输出就说明已经好了，跳过
ls -d D:/code/QFlareBot/packages/plugin-cli/dist/cli.js
cd D:/code/QFlareBot && pnpm install --filter '@qqbot/plugin-cli...' && pnpm --filter '@qqbot/plugin-cli...' build
# PATH 里没有 pnpm 就用：node "D:/nodejs/node_modules/corepack/dist/pnpm.js" 代替 pnpm
```

同一套 `../../` 同时满足本地与 CI 两种布局，**不要改**：本地是 `QFlareBot-Private-Plugin/<短名>` ↔ 同级的 `QFlareBot`；CI 是把本仓库检出到 `plugin/`、QFlareBot 检出到 `QFlareBot/`（见 `.github/workflows/ci.yml` 的 `path` 与 `working-directory`），`plugin/<短名>` 往上两级正好又是 `QFlareBot`。

## 1. 复制一份现成插件当模板

**不要手写那一堆配置文件**，`demo/` 里的 `tsconfig.json`、`vitest.config.ts`、`package.json` 的 scripts、`file:` 相对路径、`.gitignore` 都已经是对的。

```bash
cd D:/code/QFlareBot-Private-Plugin
cp -r demo/ <短名>/          # 会连 node_modules/、dist/ 一起拷，下一步就删掉
rm -rf <短名>/node_modules <短名>/dist
rm -f  <短名>/package-lock.json <短名>/manifest.json   # 里面还是 demo 的名字，必须重生
rm -f  <短名>/src/*.test.ts                            # demo 的业务测试，换成你自己的
```

拷完应该剩这些：`.gitignore`、`LICENSE`、`README.md`、`package.json`、`src/index.ts`、`tsconfig.json`、`vitest.config.ts`。

- `README.md`：**留下但改写**——标题、描述、用法都是 demo 的（`LICENSE` 保留即可）。
- `src/index.ts`：**保留文件名，内容在 §3 整份重写**。

> **⚠️ 这套流程里唯一能「静默通过全部检查」的坑：只改包名、不重写 `src/index.ts`。**
> `npm run sync` 会把 demo 那 6 条命令原样抽成新插件的声明清单，而 `check-manifest.mjs` 只比对两份清单**一致**、不比对内容，所以照样打勾——装到机器人上跑的其实是 demo 的代码。
> §5 那个脚本会把清单里的**命令列表**打出来：看到 `/hello、/count、/sign…` 就说明你忘了重写源码。

`<短名>` 只能是小写字母、数字、`-`、`_`，并且**必须是这个插件唯一的标识**：它同时是 `definePlugin` 的 `name`、KV 前缀、D1 表前缀（`p_<短名>_`）和路由前缀（`/p/<短名>/`）。装到同一台机器人上的插件短名不能是彼此的 `-`/`_` 变体（`my-plugin` 与 `my_plugin` 的表前缀都是 `p_my_plugin_`，会撞车）。

**短名和命令名没有关系**（`demo` 这个插件的命令是 `/hello`）。没有特别理由就用主命令名——这样目录名、包名后缀、`definePlugin.name`、安装来源的 `#<短名>` 四处天然一致。

## 2. 改 `package.json`

- `name` → `qflarebot-plugin-<短名>`
- `version` → `0.1.0`
- `description` → 一句话
- **`devDependencies` 一个字都不要动**（`file:../../QFlareBot/packages/*` 换成版本号就装不上了）

## 3. 写 `src/index.ts`（整份重写，不要留着 demo 的代码）

`definePlugin({ name })` **必须严格等于目录名**，构建时校验，不一致直接构建失败。

```ts
import { definePlugin } from '@qqbot/sdk'

/** 与 configSchema 对应；面板保存的配置通过 ctx.config 注入（缺的字段回落 defaultConfig） */
export interface Config {
  reply: string
}

export default definePlugin<Config>({
  name: '<短名>',
  apiVersion: 1,
  displayName: '<面板显示名>',
  description: '<一句话>',
  permissions: [],

  configSchema: {
    type: 'object',
    properties: { reply: { type: 'string', title: '回复内容', default: 'pong' } },
    required: ['reply'],
  },
  defaultConfig: { reply: 'pong' },

  commands: {
    // 最简形式：返回值就是回复（字符串或消息对象），返回 undefined 表示不回复
    probe: ({ ctx }) => ctx.config.reply,

    // 要描述 / 别名 / 权限 / 子命令时用对象形式
    help: {
      description: '看用法',
      usage: '/help',
      aliases: ['帮助'],
      handler: async () => '……',
    },
  },
})
```

`apiVersion` 写的是插件**最低**要求的契约版本。**保守做法：按用到的最高一档能力显式写个小数字**——省略等于要求构建时 SDK 的最新契约（当前 4），插件在老机器人上会被拒装。

| 版本 | 新增 | 什么时候必须写它 |
| --- | --- | --- |
| 1 | 初版契约 | 只用 `ctx.config/kv/db/r2`、`ctx.api`、`session` 基础字段、命令/正则/事件/按键/cron/routes |
| 2 | `ctx.db.batch()`、`ctx.publicUrl` | 用到 `batch()` 就写 2（`publicUrl` 可能没有值，读了要有退路，不必为它写 2） |
| 3 | `ctx.botAdmins`、`meetsPermission()`、`mentionedUsers()`、`session.isBotAdmin`、`session.quote` | 用了 SDK 导出的 `meetsPermission` / `mentionedUsers` **必须写 3**（老机器人上没这个导出，构建会失败）。只读 `session.isBotAdmin` / `session.quote` 不必 |
| 4 | `ctx.images`、`ctx.browser` | 判断过 `undefined` 的不必写 4 |

判断口径：**SDK 导出的函数算新能力**（`@qqbot/sdk` 一律解析成机器人仓库那一份，老机器人上没有就构建失败）；纯数据字段不算。

要更细的 API（消息 / 键盘 / 事件 / 权限 / 群管理 / D1 与 KV 的省额度写法 / 插件网页）就看 `jrys/`、`demo/` 的实际用法——**它们是能跑通的样例，优先照抄而不是凭印象写**。

## 4. 写 `src/index.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { runCommand } from '@qqbot/sdk/testing'
import plugin, { type Config } from './index.js'

describe('<短名> plugin', () => {
  it('用默认配置回复', async () => {
    expect((await runCommand(plugin, 'probe')).replies).toEqual(['pong'])
  })

  it('使用面板保存的配置', async () => {
    const config: Config = { reply: '在的' }   // 要给全：mock 的 ctx.config 是完整 Config 不是 Partial
    expect((await runCommand(plugin, 'probe', '', { ctx: { config } })).replies).toEqual(['在的'])
  })
})
```

`runCommand(plugin, '命令名')` 的第二个参数是**命令名本身，不带 `/`**（别名也认）。

## 5. 装依赖、生成声明清单、跑测试

```bash
cd D:/code/QFlareBot-Private-Plugin/<短名>
npm install
npm run sync                            # 构建 + 生成 manifest.json（声明清单）
npm run typecheck
npm test
node ../scripts/check-manifest.mjs .    # 声明清单必须与源码一致，不一致面板会拒绝安装
```

**`npm run sync` 这步不能省。** 面板安装时读的是插件目录里这份 `manifest.json`（声明清单），机器人构建时又按源码重新抽一份，两者不一致这次构建就会失败。改完源码必须重跑、并把新的 `manifest.json` 一起提交。

`check-manifest.mjs` 会把清单里的 `name` / `version` / `apiVersion` / 命令列表打出来——**看一眼命令对不对**，它只保证两份清单一致，不保证内容是你要的（见 §1 那个坑）。

## 6. 把新插件加进 CI

`.github/workflows/ci.yml` 里加一个名字，就一处：

```yaml
      matrix:
        plugin: [jrys, demo, <短名>]
```

CI 会为每个子目录单独跑一遍：并排检出两个仓库（`plugin/` 与 `QFlareBot/`）→ 构建 plugin-cli → `npm ci` → typecheck → build + 声明清单校验 → test。

## 7. 提交推送

```bash
cd D:/code/QFlareBot-Private-Plugin
git add -A
git status --short        # 确认收进去的是 <短名>/ 下的 10 个文件 + 第 6 步改的 ci.yml，没有 node_modules/ 或 dist/
git commit -m "feat(<短名>): <一句话>"
git push
```

`<短名>/` 下应该是这 10 个文件：`.gitignore`、`LICENSE`、`README.md`、`manifest.json`、`package-lock.json`、`package.json`、`src/index.test.ts`、`src/index.ts`、`tsconfig.json`、`vitest.config.ts`。**`manifest.json` 和 `package-lock.json` 都必须在里面。**

## 8. 回报给用户（这一步别省）

```bash
git ls-remote origin refs/heads/main      # 取 40 位 sha
```

然后告诉用户去面板「插件 → 安装插件」粘这条：

```
git:Rain48698/QFlareBot-Private-Plugin@<40 位 sha>#<短名>
```

**必须是完整 40 位 sha。** 这是唯一不让面板调 GitHub API 的写法（面板在浏览器里匿名解析链接，配额只有每 IP 每小时 60 次，超了会报一个很像「仓库不存在」的 403）。自己发现是本仓库的 GitHub 链接也**不要**给用户——链接写法要调 2 次 API，用户很可能正好踩到限流。

## 硬规则（违反会构建失败或装不上）

| 规则 | 违反了会怎样 |
| --- | --- |
| `definePlugin({ name })` == 目录名 == 包名去掉 `qflarebot-plugin-` | 构建期报 `name 与包名不一致` |
| 改完源码跑 `npm run sync` 并提交 `manifest.json` | 声明清单与源码不一致，面板拒绝安装 / 构建失败 |
| `package-lock.json` **一律提交**（哪怕只有 devDependencies） | 缺了它 CI 会退回 `npm install`、装出的版本不确定；有第三方 `dependencies` 时构建机会直接失败 |
| **不要**提交 `node_modules/`、`dist/` | 已在 `.gitignore` 里；加进去只会让仓库变脏 |
| 不动 `devDependencies` 里的 `file:../../QFlareBot/packages/*` | 换成版本号就装不上（两个包都不发 npm） |
| 插件代码不能 import Node 内置模块（`node:fs`、`net`…） | 插件跑在 workerd 里，构建期报 `Could not resolve "node:fs"` |
| 用 D1 时表名写 `{表名}` **占位符** | 运行时展开成 `p_<短名>_<表名>`；写死表名会被拦住 |
| `permissions` 里没有 `r2` | 联合类型里就没这一项，写了编译报错（用 `ctx.r2` 不用声明） |
| 新增 D1 表要在 `onBoot` 里惰性建，别只写在 `onInstall` | `onInstall` 只跑一次且**不比较版本号**，升级时不会重跑，新表就永远不会被建 |
| 声明了 Durable Object 要提醒用户先改机器人仓库 | 预检会拦下来并给出要补的 `migrations`；不加的话之后每次构建都失败 |
| 不改仓库可见性、不动别的插件目录、不建第二个副本 | 私有就全都装不上 |

## 报错速查

| 现象 | 原因与修法 |
| --- | --- |
| `name 与包名不一致：package.json 是 "qflarebot-plugin-x"，期望 name 为 "x"` | `definePlugin({ name })` 必须等于包名去掉 `qflarebot-plugin-` |
| `manifest.json 与 dist/manifest.json 不一致` | 跑 `npm run sync`，把新的 `manifest.json` 提交 |
| `Could not resolve "node:fs"` | 插件里用了 Node 内置模块，删掉；只给测试用就放进测试文件 |
| `插件不能 import 框架内部的包 @qqbot/runtime` | 能力只能从 `ctx` / `session` 取，只有 `@qqbot/sdk` 可以打包进插件 |
| `抽取清单时无法在 Node 中加载 cloudflare:xxx` | 改成在处理器内部 `await import('cloudflare:xxx')` |
| 面板安装报 `HTTP 403` / `解析分支 main 的最新 commit 失败` | 面板的匿名 GitHub API 限流，不是你代码的问题。改用 40 位 sha 的 `git:` 来源（见 §8） |
| 面板安装报 404 | 仓库是真的读不到：被改成私有了，或者这个 commit 下没有提交 `manifest.json` |
| 本地 `npm install` 报找不到 `../QFlareBot/packages/...` | 两个仓库不在同一个父目录，或者 `file:` 的层级被改过 |
| 测试里 `no such table: p_<短名>_<表>` | 测试替身不跑 `hooks`，测试里自己调一次 `plugin.hooks.onInstall(ctx)`；**线上出现同样的错是另一回事**——`onInstall` 升级不重跑，新表要在 `onBoot` 里惰性建 |
| `git push` 报 `Failed to connect to github.com:443 over proxy 127.0.0.1` | 本机代理没开。不要改全局配置，同一条命令临时清空代理重跑：`git -c http.proxy= -c https.proxy= push` |

> 手边如果有 QFlareBot 插件开发技能（`D:/code/QFlareBot-plugin-generator`），它的 `references/` 有更细的实现细节，可以按需读。但注意它自带的 `scaffold.mjs` 假设的是**经典单插件布局**，直接生成到这个仓库里要手动改两处：`file:` 多退一级、删掉它生成的 per-plugin `.github/workflows/ci.yml`。**通常直接照 `demo/` 复制更省事。**

---

# 装到机器人

面板「插件 → 安装插件」里粘贴下面任一种来源，预检通过后确认安装，会就地触发一次构建。

```
git:Rain48698/QFlareBot-Private-Plugin@<40 位 sha>#jrys     ← 推荐
https://github.com/Rain48698/QFlareBot-Private-Plugin/tree/main/demo
```

`#` 后面是子目录，commit 至少 7 位 hex。推荐第一种：**40 位完整 sha 是唯一不调 GitHub API 的写法**，而链接写法要调 2 次、会撞上每 IP 每小时 60 次的匿名限流（报错文案会误导成「仓库不存在」）。

**装完之后**：安装记录钉在那个 commit 上，往这里推新代码不会自动生效。要更新去面板「已装插件 → 检查全部更新 → 更新选中」。

两个插件都只用 `ctx` 能力，没有第三方运行时依赖、没有 Durable Object，装之前不需要往机器人仓库补 `migrations`。

# 本地开发

```
D:\code\
├── QFlareBot\                        ← 框架源码检出
└── QFlareBot-Private-Plugin\         ← 本仓库
    ├── demo\                         ← 新插件照它抄
    ├── jrys\
    └── scripts\check-manifest.mjs
```

插件在仓库的子目录里，所以 `devDependencies` 的 `file:` 要往上退两级（`file:../../QFlareBot/packages/*`）——退几级取决于插件在仓库里有多深，层级错了本地能装、CI 必断。

```bash
cd jrys                       # 或 demo
npm install
npm run typecheck             # tsc --noEmit
npm test                      # vitest
npm run sync                  # 构建 + 把 dist/manifest.json 拷成插件目录的 manifest.json
```

**挪动插件目录后必须删掉 `package-lock.json` 重新 `npm install`**：npm 不会清掉旧路径留下的 lockfile 条目，`npm ci` 会读到两份。

# CI

`.github/workflows/ci.yml` 对 `matrix.plugin` 里的每个子目录跑一遍，步骤见上面 §6。CI 只是自查，与面板安装无关——安装只看仓库里的 `manifest.json` 和构建机能不能打包。
