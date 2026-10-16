# QFlareBot 自用插件

[QFlareBot](https://github.com/QFlareBot/QFlareBot) 插件。**一个仓库放多个插件，每个插件一个子目录。**

| 目录 | 短名 | 做什么 |
| --- | --- | --- |
| `demo/` | `demo` | 签到 / 积分 / 排行 |
| `jrys/` | `jrys` | 今日运势 |

> 仓库名里的 `Private` 只是个名字。**这个仓库必须保持 public**——面板安装时匿名读仓库里的 `manifest.json`，构建机也匿名下载源码，私有仓库两步都会 404。

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

没有就 `git clone https://github.com/QFlareBot/QFlareBot D:/code/QFlareBot`，并构建一次 plugin-cli（它提供 `qqbot-plugin` 命令）：

```bash
ls -d D:/code/QFlareBot/packages/plugin-cli/dist/cli.js    # 有输出就跳过下面这条
cd D:/code/QFlareBot && pnpm install --filter '@qqbot/plugin-cli...' && pnpm --filter '@qqbot/plugin-cli...' build
# PATH 里没有 pnpm 就用 node "D:/nodejs/node_modules/corepack/dist/pnpm.js" 代替
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
npm run sync                      # 构建 + 生成 manifest.json（声明清单）
npm run typecheck
npm test
node ../scripts/check-manifest.mjs .
```

`manifest.json` **必须提交**——面板安装前读的就是它。最后那个脚本会把清单里的 name / version / 命令列表打出来，**扫一眼确认是这个插件**。

## 5. 加进 CI

`.github/workflows/ci.yml` 的 matrix 加个名字，就这一处：

```yaml
        plugin: [jrys, demo, <短名>]
```

## 6. 提交推送

```bash
cd D:/code/QFlareBot-Private-Plugin
git add -A
git status --short        # 确认收进去的是 <短名>/ 下的文件 + 第 5 步的 ci.yml，没有 node_modules/ 或 dist/
git commit -m "feat(<短名>): <一句话>"
git push
```

`<短名>/` 下该进仓库的：`src/`、`package.json`、`package-lock.json`、`manifest.json`、`tsconfig.json`、`vitest.config.ts`、`LICENSE`、`README.md`。`node_modules/` 与 `dist/` 已在 `.gitignore` 里，不该出现。

## 7. 回报给用户

```bash
git ls-remote origin refs/heads/main      # 取 40 位 sha
```

```
git:Rain48698/QFlareBot-Private-Plugin@<40 位 sha>#<短名>
```

**必须写完整 40 位 sha**：这是唯一不让面板调 GitHub API 的写法。面板匿名解析 GitHub 链接的配额只有每 IP 每小时 60 次，超了会报一个很像「仓库不存在」的 403——所以不要直接给用户 GitHub 链接。

## 会被拦下来的情况

| 现象 | 原因 |
| --- | --- |
| 构建期 `name 与包名不一致` | 目录名 / 包名 / `definePlugin({ name })` 三处没对齐 |
| 本地 `npm install` 报找不到 `../QFlareBot/packages/...` | `file:` 的层级不对，或 QFlareBot 不在仓库的上一级 |
| CI 报 `manifest.json 与 dist/manifest.json 不一致` | 改了源码没重跑 `npm run sync` |
| 面板装时报 404 | `manifest.json` 没提交，或者这个 commit 下读不到 |
| 面板装时报 403 | 面板的匿名 GitHub API 限流，不是插件的问题——改用上面那条 40 位 sha 的来源 |
| `git push` 报 `Failed to connect to github.com:443 over proxy 127.0.0.1` | 本机代理没开。不要改全局配置，同一条命令加 `-c http.proxy= -c https.proxy=` 重跑 |

---

# 装到机器人

面板「插件 → 安装插件」粘贴（`#` 后面是子目录）：

```
git:Rain48698/QFlareBot-Private-Plugin@<40 位 sha>#jrys
```

**安装记录钉在那个 commit 上**，往仓库推新代码不会自动生效；要更新去面板「已装插件 → 检查全部更新 → 更新选中」。

两个插件都只用 `ctx` 能力，没有第三方运行时依赖、没有 Durable Object，装之前不需要往机器人仓库补 `migrations`。

# 开发与 CI

```bash
cd <短名>
npm run typecheck             # tsc --noEmit
npm test                      # vitest
npm run sync                  # 构建 + 把 dist/manifest.json 拷成插件目录的 manifest.json
```

`devDependencies` 的 `file:` 层级取决于插件在仓库里有多深——**挪过目录就必须删掉 `package-lock.json` 重新 `npm install`**。

仓库根的 `.github/workflows/ci.yml` 会对 matrix 里的每个子目录跑一遍：并排检出 `plugin/` 与 `QFlareBot/` → 构建 plugin-cli → `npm ci` → typecheck → build + 声明清单校验 → test。CI 只是自查，与面板安装无关。
