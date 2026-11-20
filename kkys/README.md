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

播放结果带一排按键：**最新一集**（当前线路最后一集）、**换线路**（回到线路列表，读会话不发请求）、
**一起看**（用会话里缓存的直链生成房间链接，不再请求站点）。会话存 KV，30 分钟过期。

选线路进到剧集页后，底部也有一个**换线路**（只在有多条线路时出现）；单线路的片子不加这个按钮，
因为点进去还是同一条线路，纯噪音。

## 额度与子请求

免费版 Worker 一次事件只有 **50 个子请求**、**10 ms CPU**，全机器人所有插件共用，所以这里做了几处收敛：

- **凭证在同一次事件内复用**。`/看剧 斗罗大陆 2` 要依次走搜索、详情、播放页，每步都要凭证；
  不缓存的话一条命令会读 4 次 KV、发 4 次首页请求。`createKkys()` 按客户端实例缓存一个 Promise，
  一次事件只读一次 KV、只发一次首页。
- **挑战页不重复请求**。第一次首页请求返回的 850 响应里就带着挑战页，直接交给 PoW 解算，
  不再自己再拉一遍首页。
- **换线路 / 一起看都是零请求**。线路和剧集在选片时已经全存进 KV，这两个按键只读会话。
- **PoW 结果存 KV 复用**（12 小时 TTL，20 分钟内不再确认），只在真被反爬拦截时才重跑。

破解本身要跑几万到几十万次哈希，实测 51 ms / 9.4 万次——首次命中反爬的那次请求会超过免费版 10 ms 的
CPU 预算，但只在凭证失效后发生一次，之后都是一次 KV 读。付费版（30 s CPU）没有这个问题。

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

面板「插件 → 安装插件」粘贴（`#` 后面是子目录）：

```
git:Rain48698/QFlareBot-Private-Plugin@20a501b2f4bcc8d13b792bd6054c77227c82d1e0#kkys
```

仓库根的 [README](../README.md) 里有这条链接的最新版本——改代码推上去之后跑
`node scripts/update-readme-links.mjs` 会把两处都更新。**要用完整 40 位 sha**：短 sha 和 GitHub 链接都要调一次
GitHub API，面板的匿名配额只有每 IP 每小时 60 次，超了会报一个很像「仓库不存在」的 403。

安装记录钉在那个 commit 上，推新代码不会自动生效；更新走面板「已装插件 → 检查全部更新」。
本插件没有第三方运行时依赖、没有 Durable Object，装之前不需要往机器人仓库补 `migrations`。

## 测试

两套测试，都不需要机器人和网络：

| 文件 | 测什么 |
| --- | --- |
| `src/kkys.test.ts` | 纯函数：页面解析（对 `src/__fixtures__/` 的真实页面）、PoW 解算（用 `node:crypto` 的 SHA-1 反向校验）、标题相关性、线路切片、链接工具 |
| `src/index.test.ts` | 命令与按键的端到端：桩 `fetch` 走完首页 → 搜索 → 详情 → 播放页，断言回复内容、反爬自动破解、会话复用、按键数据链路 |

改解析正则时对着 `src/__fixtures__/` 里的样本改，`kkys.test.ts` 会立刻告诉你有没有解析错。
改按键时注意 `src/index.test.ts` 里那条「按键 data 的前缀必须是插件真有的处理器名」——按键 id 写错不会报错，
只会点了没反应，测试是唯一的兜底。

## 文档

- [插件开发指南](https://qflarebot.github.io/plugin-guide)
- [平台能力对照](https://qflarebot.github.io/capabilities)
- [升级与运维](https://qflarebot.github.io/maintenance)
- [发布插件](https://qflarebot.github.io/publish)
- 站点逆向与反爬机制细节（同源的 Python CLI 仓库）：`kkys-nixiang` 的 `kkys_py/README.md`
