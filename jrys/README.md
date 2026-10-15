# qflarebot-plugin-jrys

群内每日运势：同一人同一天结果固定，支持 @ 他人帮看

[QFlareBot](https://github.com/QFlareBot/QFlareBot) 插件。

## 用法

| 命令 | 说明 |
| --- | --- |
| `/jrys` | 看自己的今日运势 |
| `/jrys @群友` | 帮别人看（别名 `/运势`） |

回复长这样：

```
今日运势 · 2026-10-15
等级：小吉
运势：适合把拖了很久的小事收尾，做完心里会很轻。
幸运数字：7
幸运颜色：天青
```

- **同一人同一天结果固定**：由 `(用户 openid, 日期)` 散列决定，第二天自然换一份。
- 日期按时区算（默认 UTC+8），所以北京时间的日界跟群友对得上；可在面板改。
- 运势里的四行只有第一次抽的那份作数：抽完写进 D1，之后再来一律读存档——
  文案改了也不会把今天已经发出去的结果改掉。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `timezoneOffset` | `8` | 「今天」按哪个时区算（UTC 偏移小时） |
| `atTarget` | `true` | 帮别人看时要不要 @ 对方 |

## 数据

一张 D1 表 `p_jrys_fortune`（`{fortune}` 占位，运行时展开），主键 `(user_id, day)`：

| 列 | 说明 |
| --- | --- |
| `user_id` / `user_name` | 运势属于谁（被看的人，不是发起的人） |
| `day` | 目标时区下的 `YYYY-MM-DD` |
| `target_id` | 抽的时候在哪个会话（群 openid / 单聊用户 openid） |
| `level` / `description` / `lucky_number` / `lucky_color` | 发出去的那四行 |
| `drawn_at` | 抽的时间戳 |

写入量与消息数无关：**每人每天最多一行**，第二次来只读。表上没有额外索引——
查询一律走主键，多一个索引只会让每次写入多算一行。

## 开发

SDK 与构建工具不发 npm，从 QFlareBot 源码构建，和本仓库**并排**放：

```bash
cd ..
git clone https://github.com/QFlareBot/QFlareBot
(cd QFlareBot && pnpm install --filter '@qqbot/plugin-cli...' && pnpm --filter '@qqbot/plugin-cli...' build)
cd qflarebot-plugin-jrys
npm install
```

```bash
npm run typecheck
npm test          # @qqbot/sdk/testing 直接驱动处理器，不需要机器人
npm run build     # 生成 dist/plugin.js 与 dist/manifest.json
npm run sync      # 构建并把 dist/manifest.json 复制到仓库根目录（声明清单，随代码提交）
```

`devDependencies` 里的 `file:../QFlareBot/packages/*` 就是这份本地检出——CI 也照同一相对路径检出 QFlareBot，
所以别改成别的相对路径。

根目录的 `manifest.json` 是**声明清单**：机器人安装前读它展示权限、检查撞名与依赖，构建时再与源码抽出的清单比对，
不一致就失败。改了插件定义就跑 `npm run sync`。CI 会检查它有没有过期。

用了第三方包就写进 `dependencies` 并**提交 lockfile**，没有 lockfile 构建会失败。

## 装到机器人

推到公开的 GitHub 仓库，面板「插件 → 安装插件」粘贴仓库链接，预检后安装并触发构建。只支持公开仓库。

## 文档

- [插件开发指南](https://qflarebot.github.io/plugin-guide)
- [平台能力对照](https://qflarebot.github.io/capabilities)
- [面板与插件页面](https://qflarebot.github.io/ui)
- [发布插件](https://qflarebot.github.io/publish)
