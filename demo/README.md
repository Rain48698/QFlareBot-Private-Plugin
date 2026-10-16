# qflarebot-plugin-demo

签到 / 积分 / 排行的演示插件，也是**新增插件时的模板**（照抄它的结构最省事，见[仓库根 README](../README.md)）。

[QFlareBot](https://github.com/QFlareBot/QFlareBot) 插件。

## 用法

| 命令 | 说明 |
| --- | --- |
| `/hello [名字]` | 回问候语，走面板配置 |
| `/count [N]` | 生成器逐条回复（别名 `/数数`） |
| `/sign` | 每日签到拿积分（别名 `/签到`） |
| `/points` | 看自己的积分（别名 `/积分`） |
| `/rank` | 本群积分排行榜（别名 `/排行`） |
| `/sign reset @某人` | 清掉某人的记录，需要群管理员 |

## 数据

一张 D1 表 `p_demo_signs`（`{signs}` 占位，运行时展开），主键 `(group_id, user_id)` + `WITHOUT ROWID`。
一人一行，签到最多改一行；重复签到靠 UPSERT 里的 `WHERE day <> excluded.day` 做到 0 行写入。

## 开发

本插件是本仓库 `QFlareBot-Private-Plugin` 的一个子目录。SDK 与构建工具都不发 npm，得有一份 QFlareBot 源码检出放在**仓库的上一级**：

```
D:\code\
├── QFlareBot\                        ← 框架源码检出
└── QFlareBot-Private-Plugin\
    └── demo\                         ← 本插件
```

```bash
cd D:/code/QFlareBot-Private-Plugin/demo
npm install
```

```bash
npm run typecheck
npm test          # @qqbot/sdk/testing 直接驱动处理器，不需要机器人
npm run build     # 生成 dist/plugin.js 与 dist/manifest.json
npm run sync      # 构建并把 dist/manifest.json 复制到插件目录（声明清单，随代码提交）
```

`devDependencies` 里的 `file:../../QFlareBot/packages/*` 就是那份本地检出——**插件在仓库里深一级，`file:` 就要多退一级**；CI 也照同一相对层级检出 QFlareBot，所以别改成别的相对路径。

插件目录下的 `manifest.json` 是**声明清单**：机器人安装前读它展示权限、检查撞名与依赖，构建时再与源码抽出的清单比对，不一致就失败。改了插件定义就跑 `npm run sync`。CI 会检查它有没有过期。

用了第三方包就写进 `dependencies` 并**提交 lockfile**，没有 lockfile 构建会失败。

## 装到机器人

面板「插件 → 安装插件」粘贴（`#` 后面是子目录，sha 至少 7 位、推荐完整 40 位）：

```
git:Rain48698/QFlareBot-Private-Plugin@<40 位 sha>#demo
```

## 文档

- [插件开发指南](https://qflarebot.github.io/plugin-guide)
- [平台能力对照](https://qflarebot.github.io/capabilities)
- [面板与插件页面](https://qflarebot.github.io/ui)
- [发布插件](https://qflarebot.github.io/publish)
