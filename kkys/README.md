# qflarebot-plugin-kkys

[QFlareBot](https://github.com/QFlareBot/QFlareBot) 插件：搜索 kkys01.com（可可影视）影片、解析 m3u8/mp4 播放直链、
生成一起看房间链接。移植自 `kkys-nixiang` 仓库的 `kkys_py/kkys_cli.py`，业务行为与那个 CLI 对齐。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/看剧 <片名>` | 搜索并列出结果，点按钮选片 → 选线路 → 选集（别名 `/kkys`、`/可可影视`） |
| `/看剧 <片名> <集数>` | 一步到位：搜索 → 最佳线路 → 指定集 → 直链 + 一起看链接 |
| `/一起看 <视频直链>` | 把直链转成一起看房间链接 |
| `/看剧 状态` | 查看 Cookie / t 参数 / 首页连通性（仅管理员） |
| `/看剧 刷新` | 强制重破反爬、刷新凭证（仅管理员） |

集数写在片名后面，用空白分隔：`/看剧 斗罗大陆 120`。片名本身带数字（`/看剧 斗罗大陆2`）不会被当成集数——
不带空白分隔的数字仍是片名的一部分，走搜索列表。末尾数字搜不到结果时也会退回按整串当片名再搜一次。

播放结果带一排按键：**最新一集**（当前线路最后一集）、**换线路**、**一起看**（用会话里缓存的直链生成房间链接，
不再请求站点）。会话存 KV，30 分钟过期。

## 配置

面板「插件 → 可可影视」里改：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 过滤无关搜索结果 | 开 | 站点是模糊匹配，搜不到时会返回无关影片；开启后按标题相似度剔除（判定宽松，避免误杀） |
| 搜索结果展示条数 | 8 | `/看剧 <片名>` 最多列几条 |
| 一起看地址 | `https://yqk.060908.xyz/watch.html` | 换成自己部署的一起看站点 |
| 手动 Cookie | 空 | **应急**：站点改了挑战页格式、自动破解失效时，从浏览器复制 `cdndefend_js_cookie=...` 填进来 |

## 反爬（cdndefend）

站点直连首页返回 **HTTP 850** + JS 挑战页，破解逻辑与 CLI 一致：解析混淆数组 → 模拟数组旋转 → 取 40 位 hex 的 `c`
与检查偏移 `n1` → 穷举 `i` 使 `SHA1(c + i)` 的 `[n1] == 0xB0 && [n1+1] == 0x0B`。

与 CLI 的两处差异：

- **PoW 用纯 JS 单块 SHA-1，不用 `crypto.subtle`。** 实测纯 JS 183 万 hash/s，WebCrypto 逐次 `await` 只有
  6.4 万 hash/s（每次调用的开销吃掉了全部收益）。消息是 40 位 hex 加十进制 i，长度 40..47 字节，永远落在
  SHA-1 的一个 64 字节块里，所以没有多块逻辑；`W[0..9]` 跨 i 恒定，循环外只算一次。
- **解出来的 Cookie 存 KV 复用**（12 小时 TTL，20 分钟内不再确认）。破解本身要跑几万到几十万次哈希，
  实测 51ms / 9.4 万次；Worker 免费版单次 CPU 只有 10ms，扛不住每次都破解，付费版（30s）没问题。
  命中反爬时才重跑，其余时候只是读 KV。

站点改混淆格式时正则会失配，日志里会出现「反爬挑战页格式变了（正则失配）」——这时要重新分析挑战页 JS，
或者临时用面板里的「手动 Cookie」顶一下。

## 与 CLI 的其它差异

- **页面解析全是正则**，没有 BeautifulSoup。正则对着真实页面写，样本固化在 `src/__fixtures__/`（真实页面截取），
  改解析逻辑时对着样本改，`src/kkys.test.ts` 会立刻告诉你有没有解析错。
- **线路↔剧集仍然按 `.source-item-num` 累计切片**还原（详情页把 25 条线路的剧集拼在一个扁平 `.episode-list` 里，
  一条线路会被多个 `source-item` 复用，按位置对齐必然错位）。会话里存的是扁平剧集串
  `lineId-epId\t名称`，播放页 URL 由 `vodId-lineId-epId` 拼回来。
- **t 参数过期**的判定沿用 CLI 的思路：搜索返回空列表时强制重取一次 t 再搜一遍（站点此时返回 200 + 空列表，
  光看状态码分不出来）。

## 开发

本插件是 [QFlareBot-Private-Plugin](https://github.com/Rain48698/QFlareBot-Private-Plugin) 仓库里的 `kkys/` 子目录。
SDK 与构建工具不发 npm，从 QFlareBot 源码构建——插件在仓库里深一层，所以 **QFlareBot 检出要放在仓库的上一级**：

```
D:\code\
├── QFlareBot\                        ← 框架源码检出
└── QFlareBot-Private-Plugin\
    └── kkys\                         ← 本插件
```

```bash
cd D:/code/QFlareBot-Private-Plugin/kkys
rm -rf node_modules dist && rm -f package-lock.json   # 挪过目录就必须重生 lockfile
npm install
npm run typecheck
npm test          # @qqbot/sdk/testing 直接驱动处理器，不需要机器人
npm run build     # 生成 dist/plugin.js 与 dist/manifest.json
npm run sync      # 构建并把 dist/manifest.json 复制到插件目录（声明清单，随代码提交）
node ../scripts/check-manifest.mjs .
```

`devDependencies` 里的 `file:../../QFlareBot/packages/*` 就是那份检出（退两级），**别改成别的层级**；
仓库根的 `.github/workflows/ci.yml` 按 matrix 对每个子目录跑同一套检查，CI 里的检出布局与本地一致。

`manifest.json` 是**声明清单**：机器人安装前读它展示权限、检查撞名与依赖，构建时再与源码抽出的清单比对，
不一致就失败。改了插件定义就跑 `npm run sync`，CI 会检查它有没有过期。

## 装到机器人

面板「插件 → 安装插件」粘贴（`#` 后面是子目录，sha 用 `git ls-remote origin refs/heads/main` 取）：

```
git:Rain48698/QFlareBot-Private-Plugin@<40 位 sha>#kkys
```

安装记录钉在那个 commit 上，推新代码不会自动生效；更新走面板「已装插件 → 检查全部更新」。
本插件只用 `ctx` 能力，没有第三方运行时依赖、没有 Durable Object，装之前不需要往机器人仓库补 `migrations`。

## 文档

- [插件开发指南](https://qflarebot.github.io/plugin-guide)
- [平台能力对照](https://qflarebot.github.io/capabilities)
- [发布插件](https://qflarebot.github.io/publish)
- 站点逆向与反爬机制细节（同源的 Python CLI 仓库）：`kkys-nixiang` 的 `kkys_py/README.md`
