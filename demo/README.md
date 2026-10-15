# qflarebot-plugin-demo

测试用插件

[QFlareBot](https://github.com/QFlareBot/QFlareBot) 插件。

## 开发

SDK 与构建工具不发 npm，从 QFlareBot 源码构建，和本仓库**并排**放：

```bash
cd ..
git clone https://github.com/QFlareBot/QFlareBot
(cd QFlareBot && pnpm install --filter '@qqbot/plugin-cli...' && pnpm --filter '@qqbot/plugin-cli...' build)
cd qflarebot-plugin-demo
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
