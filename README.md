# QFlareBot 自用插件

给 [QFlareBot](https://github.com/QFlareBot/QFlareBot) 写的插件，一个仓库放多个，每个插件一个子目录。

| 目录 | 插件 | 包名 | 做什么 |
| --- | --- | --- | --- |
| `jrys/` | `jrys` 今日运势 | `qflarebot-plugin-jrys` | `/jrys [@群友]`，同一人同一天结果固定，按 UTC+8 分日 |
| `demo/` | `demo` 签到示例 | `qflarebot-plugin-demo` | `/hello`、`/count`、`/sign`、`/points`、`/rank`、`/sign reset`，用来验证签到 / 积分 / 排行这类玩法 |

> 仓库名里的 `Private` 只是个名字。**这个仓库必须是 public**——面板安装插件时匿名读仓库里的
> `manifest.json`，构建机也匿名下载源码，私有仓库两步都会 404。别把它改成私有。

## 装到机器人

面板「插件 → 安装插件」里粘贴下面任一种来源，预检通过后确认安装，会就地触发一次构建。

```
https://github.com/Rain48698/QFlareBot-Private-Plugin/tree/main/jrys
https://github.com/Rain48698/QFlareBot-Private-Plugin/tree/main/demo
```

面板会把链接解析成钉在具体 commit 上的来源，等价于手写：

```
git:Rain48698/QFlareBot-Private-Plugin@<40 位 commit>#jrys
git:Rain48698/QFlareBot-Private-Plugin@<40 位 commit>#demo
```

`#` 后面是子目录，commit 至少写 7 位 hex。

**装完之后**：安装记录钉在那个 commit 上，往这里推新代码不会自动生效。要更新去面板「已装插件 →
检查全部更新 → 更新选中」。

两个插件都是纯 `ctx` 能力，没有第三方运行时依赖、没有 Durable Object，装之前不需要往机器人仓库补
`migrations`。

## 本地开发

插件的 `devDependencies` 是 `file:` 指向 QFlareBot 源码（`@qqbot/sdk` 与 `@qqbot/plugin-cli` 都不发 npm），
所以目录必须是这个布局：

```
D:\code\
├── QFlareBot\                        ← 框架源码检出
└── QFlareBot-Private-Plugin\         ← 本仓库
    ├── jrys\
    └── demo\
```

从 `jrys/` 往上两级正好是 `D:\code\`，`file:../../QFlareBot/packages/*` 才解析得到。

```bash
cd jrys                       # 或 demo
npm install
npm run typecheck             # tsc --noEmit
npm test                      # vitest
npm run sync                  # 构建 + 把 dist/manifest.json 拷成仓库根的 manifest.json
```

**改了源码一定要跑 `npm run sync` 再提交**：面板安装时读的是仓库根目录那份 `manifest.json`（声明清单），
机器人构建时又按源码重新抽一份，两者不一致这次构建就会失败。本地可以先自查：

```bash
node scripts/check-manifest.mjs jrys
```

## CI

`.github/workflows/ci.yml` 对两个插件各跑一遍：把本仓库检出到 `plugin/`、QFlareBot 检出到 `QFlareBot/`
（正是上面的并排布局），构建 SDK 与 plugin-cli，然后 `npm ci` → `typecheck` → `build` + 声明清单校验 → `test`。

CI 只是自查，与面板安装无关——安装只看仓库里的 `manifest.json` 和构建机能不能打包。
