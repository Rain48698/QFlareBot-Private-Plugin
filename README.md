# QFlareBot 自用插件

给 [QFlareBot](https://github.com/QFlareBot/QFlareBot)（跑在 Cloudflare Workers 上的 QQ 官方机器人框架）用的自建插件。
一个仓库放多个插件，每个插件一个子目录。

---

## kkys — 可可影视

搜 [kkys01.com](https://www.kkys01.com) 的影片，解析出 m3u8 / mp4 **播放直链**，再顺手生成**一起看**房间链接。
不用装 App、不用开会员页，群里发一条命令拿链接，粘进播放器就能看。

| | |
| --- | --- |
| **做什么** | `/看剧 <片名>` 搜片 → 点按钮选片、选线路、选集 → 拿到带时效签名的直链 |
| **命令** | `/看剧`（别名 `/kkys`、`/可可影视`）、`/一起看`、`/看剧 状态`、`/看剧 刷新` |
| **依赖** | 无第三方包、无 Durable Object。装到机器人上不需要改机器人仓库 |
| **权限** | `kv` + `net`（只用 `ctx.kv` 和 `fetch`） |
| **反爬** | 站点有 SHA-1 工作量证明挑战，插件自动破解并把凭证存 KV 复用，20 分钟内不重复请求首页 |
| **配置** | 面板「插件 → 可可影视」：过滤无关结果、展示条数、一起看地址、手动 Cookie（应急） |

**安装链接**（整行复制，粘到面板「插件 → 安装插件」里）：

<!-- 下面的 sha 由 scripts/update-readme-links.mjs 在每次提交后自动改写 -->
```
git:Rain48698/QFlareBot-Private-Plugin@ed2ab41e368d474ae7493a0c610b66390b337cc2#kkys
```

安装记录钉在这个 commit 上，往仓库推新代码**不会自动生效**——要更新去面板「已装插件 → 检查全部更新」。

<details>
<summary>为什么是这种格式，不是 GitHub 链接</summary>

面板的安装框在浏览器里匿名调 GitHub API 解析链接，配额只有**每 IP 每小时 60 次**，超了会报一个很像「仓库不存在」的 403。
`git:<owner>/<repo>@<完整 40 位 sha>#<子目录>` 是唯一**完全不调 API** 的写法。

用 40 位 sha 还有个好处：装的是哪一个版本是钉死的，不会因为上游推了新提交而在重装时悄悄变。

想知道当前该用哪个 sha：`git ls-remote https://github.com/Rain48698/QFlareBot-Private-Plugin refs/heads/main`。
</details>

完整用法、配置说明、反爬机制、开发步骤见 [kkys/README.md](./kkys/README.md)。

---

# 给 AI agent：把做好的插件推进这个仓库

**插件是被做好、验过之后才交到你手里的。你只负责把它装进这个仓库并推上去，不要重写业务代码、不要按自己的审美重构。**

插件原来是独立的仓库/目录（`D:\code\qflarebot-plugin-<短名>`），要变成这个仓库里的一个子目录。**搬进来只有两处是必改的**（第 2、3 步），其余都是核对。

## 1. 放进一个子目录

目录名就是**短名**：小写字母、数字、`-`、`_`。它有三处必须完全一致，构建时会校验：

```
<短名>/                        ← 目录名
  package.json                 → "name": "qflarebot-plugin-<短名>"
  src/index.ts                 → definePlugin({ name: '<短名>' })
```

装到同一台机器人上的插件，短名不能是彼此的 `-`/`_` 变体（`my-plugin` 与 `my_plugin` 的 D1 表前缀都是 `p_my_plugin_`，会撞车）。

## 2. 改 `devDependencies` 的 `file:` 层级（必改）

原来与 QFlareBot 同级时是 `file:../QFlareBot/packages/*`，现在插件在仓库的子目录里，要退两级：

```json
"@qqbot/sdk": "file:../../QFlareBot/packages/sdk",
"@qqbot/plugin-cli": "file:../../QFlareBot/packages/plugin-cli",
```

**插件在仓库里有多深就退几级**。这两个包都不发 npm，只能链接本地源码；层级不对就装不上（本地和 CI 都是）。整个仓库的上一级必须有 QFlareBot 检出：

```
D:\code\
├── QFlareBot\                        ← 框架源码检出
└── QFlareBot-Private-Plugin\
    └── <短名>\
```

没有就克隆，并构建一次 plugin-cli（它提供 `qqbot-plugin` 命令）：

```bash
git clone https://github.com/QFlareBot/QFlareBot D:/code/QFlareBot
ls -d D:/code/QFlareBot/packages/plugin-cli/dist/cli.js    # 有输出就跳过下面这条
cd D:/code/QFlareBot && pnpm install --filter '@qqbot/plugin-cli...' && pnpm --filter '@qqbot/plugin-cli...' build
# PATH 里没有 pnpm 就用 node "D:/nodejs/node_modules/corepack/dist/pnpm.js" 代替
```

**拉完新代码必须重建 plugin-cli**。`dist/` 不进 git，`git pull` 之后忘了重建会报一个特别容易误判的错：

```
清单校验失败：
  - 插件要求契约版本 5，当前框架只支持到 4：请先升级机器人
```

这句看着像插件写错了，其实是本地构建产物还是旧契约。本机没有 pnpm 时可以直接用包里自带的 esbuild：

```bash
cd D:/code/QFlareBot/packages/plugin-cli
./node_modules/.bin/esbuild src/cli.ts src/index.ts src/stubs/cloudflare-workers.ts \
  --bundle --platform=node --target=node20 --format=esm --outdir=dist \
  --external:esbuild --external:cloudflare:workers --sourcemap --log-level=warning
```

## 3. 删掉插件自带的 `.github/`（必改）

CI 由仓库根的那一份统一管（按子目录跑 matrix），插件目录里不能再留第二份：

```bash
rm -rf D:/code/QFlareBot-Private-Plugin/<短名>/.github
```

顺手把插件自己的 `README.md` 也改一下——标题、描述、用法要是这个插件的，别留着原来仓库的旧路径说法。

## 4. 重生依赖并自查

```bash
cd D:/code/QFlareBot-Private-Plugin/<短名>
rm -rf node_modules dist
rm -f  package-lock.json          # 换了位置，必须重生：npm 不会清掉旧路径留下的条目
npm install
npm run typecheck
npm test
npm run sync                      # 构建 + 生成 manifest.json（声明清单）
node ../scripts/check-manifest.mjs .
```

`manifest.json` **必须提交**——面板安装前读的就是它。最后那个脚本会把清单里的 name / version / apiVersion / 命令列表打出来，**扫一眼确认是这个插件**。

从别的插件复制过来当模板的，这一步尤其要看：只改了包名、忘了重写 `src/index.ts` 时，`npm run sync` 会把模板的命令原样抄成新插件的声明清单，而「清单与源码一致」这类检查只比对**两份清单是否一致**，照样通过——装到机器人上跑的是模板的代码。

## 5. 加进 CI

`.github/workflows/ci.yml` 的 matrix 加个名字，就这一处：

```yaml
        plugin: [kkys, <短名>]
```

## 6. 更新安装链接

README 里 kkys 的安装链接带 40 位 sha，推完代码要跟着改，否则用户装到的还是旧版本：

```bash
node scripts/update-readme-links.mjs
```

它会读 `git ls-remote origin refs/heads/main`，把根目录和每个插件子目录 README 里的
`@<40 位 sha>#<子目录>` 一起改写成当前 HEAD，然后提示你提交这一处改动。
加 `--check` 只检查不改，过期时退出码 1，可以挂进 CI 拦住「推了代码忘了更新链接」。
（脚本不改远程、不提交。）

**注意顺序**：先 `git push`，再跑这个脚本，再提交这一次 README 改动。
反过来做的话脚本改到的是推送前的 HEAD，链接照样差一个 commit。

## 7. 提交推送

```bash
cd D:/code/QFlareBot-Private-Plugin
git add -A
git status --short        # 确认收进去的是 <短名>/ 下的文件 + ci.yml / README.md，没有 node_modules/ 或 dist/
git commit -m "feat(<短名>): <一句话>"
git push
```

`<短名>/` 下该进仓库的：`src/`、`package.json`、`package-lock.json`、`manifest.json`、`tsconfig.json`、`vitest.config.ts`、`LICENSE`、`README.md`。`node_modules/` 与 `dist/` 已在 `.gitignore` 里，不该出现。

## 8. 回报给用户

```bash
git ls-remote origin refs/heads/main      # 取 40 位 sha
```

```
git:Rain48698/QFlareBot-Private-Plugin@<40 位 sha>#<短名>
```

**必须写完整 40 位 sha**：这是唯一不让面板调 GitHub API 的写法。短 sha 和 GitHub 链接都要解析一次，遇到限流同样会 403。

## 会被拦下来的情况

| 现象 | 原因 |
| --- | --- |
| 构建期 `name 与包名不一致` | 目录名 / 包名 / `definePlugin({ name })` 三处没对齐 |
| 构建期 `插件要求契约版本 5，当前框架只支持到 4` | 本地 plugin-cli 的 `dist` 过期了，不是插件的问题。重建一次，见第 2 步 |
| 构建期 `durableObjects 键名与入口的导出名不一致` | `export class Room` 要配 `durableObjects: { Room }`，两侧名字必须一模一样 |
| 构建期 `公开 tools 要求 apiVersion >= 5` | 声明了 `tools` 就把 `apiVersion` 抬到 5，再 `npm run sync` |
| 本地 `npm install` 报找不到 `../../QFlareBot/packages/...` | `file:` 的层级不对，或 QFlareBot 不在仓库的上一级 |
| CI 报 `manifest.json 与 dist/manifest.json 不一致` | 改了源码没重跑 `npm run sync` |
| 面板装时报 404 | `manifest.json` 没提交，或者这个 commit 下读不到 |
| 面板装时报 403 | 面板的匿名 GitHub API 限流，不是插件的问题——换成 README 里那条 40 位 sha 的写法 |
| `git push` 报 `Failed to connect to github.com:443 over proxy 127.0.0.1` | 本机代理没开。不要改全局配置，同一条命令加 `-c http.proxy= -c https.proxy=` 重跑 |

---

# 开发与 CI

```bash
cd kkys
npm run typecheck             # tsc --noEmit
npm test                      # vitest，不需要机器人
npm run sync                  # 构建 + 把 dist/manifest.json 拷成插件目录的 manifest.json
```

`devDependencies` 的 `file:` 层级取决于插件在仓库里有多深——**挪过目录就必须删掉 `package-lock.json` 重新 `npm install`**。

仓库根的 `.github/workflows/ci.yml` 会对 matrix 里的每个子目录跑一遍：并排检出 `plugin/` 与 `QFlareBot/` → 构建 plugin-cli → `npm ci` → typecheck → build + 声明清单校验 → test。CI 只是自查，与面板安装无关。

## 目录

```text
QFlareBot-Private-Plugin/
├── kkys/                       ← 可可影视
│   ├── src/index.ts            ← 插件本体（解析、反爬、命令、按键）
│   ├── src/kkys.test.ts        ← 纯函数测试，HTML 样本在 src/__fixtures__/
│   ├── src/index.test.ts       ← 命令与按键的端到端测试（桩 fetch 走完整链路）
│   ├── manifest.json           ← 声明清单，npm run sync 生成，必须提交
│   └── README.md               ← 用法、配置、反爬机制、开发步骤
├── scripts/
│   ├── check-manifest.mjs      ← 校验声明清单与构建产物一致
│   └── update-readme-links.mjs ← 把 README 里的安装链接改写到当前 HEAD
└── .github/workflows/ci.yml    ← 按 matrix 对每个插件跑同一套检查
```

## 文档

- [插件开发指南](https://qflarebot.github.io/plugin-guide)
- [统一插件工具协议](https://qflarebot.github.io/tools)
- [平台能力对照](https://qflarebot.github.io/capabilities)
- [面板与插件页面](https://qflarebot.github.io/ui)
- [升级与运维](https://qflarebot.github.io/maintenance)
- [发布插件](https://qflarebot.github.io/publish)
