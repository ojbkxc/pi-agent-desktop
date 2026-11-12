# Fork notes: 会话流量的网络代理

设置 › 通用 › **网络代理**：`直连` / `跟随系统` / `手动(http://host:port)`。

## 为什么需要这一项

本仓的模型请求**不是浏览器发的**，而是本机的 node 服务端发的（浏览器只跟 `127.0.0.1` 说话，
见 `docs/agents/sessions.md` 的 SSE 链路）。而 **node 的 `fetch` 不读系统代理**：Windows 的
WinINET 设置、macOS 的网络偏好它一概不看，只认 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`
环境变量。所以用户打开了系统代理，应用照样直连 —— 这正是「设置了代理但还是不通/很慢」的成因。

服务端本来就有代理能力：`lib/http-dispatcher.ts` 装的 `undici.EnvHttpProxyAgent` 就是按这几个
环境变量选代理的（`NO_PROXY` 每次 dispatch 现读，两个代理 URL 只在构造时读一次）。缺的只是
「谁写这些变量」+ 一个界面，也就是这一项。

## 文件与职责

| 文件 | 职责 |
|------|------|
| `lib/network-proxy.ts` | 设置的读写（Pi Web 设置文件里的 `networkProxy` 键）、系统代理探测、`resolveProxyEnv()` 纯函数、`applyNetworkProxy()`（写环境变量 + 重装 dispatcher）、`networkProxyStatus()`（只读） |
| `lib/http-dispatcher.ts` | `installHttpDispatcher({ force })`：`force` 用于代理变更后换新实例 |
| `app/api/network-proxy/route.ts` | `GET` 状态 / `PUT` 保存（**本机限定**，与监听端口、Cloudflare 隧道同规则） |
| `components/NetworkProxySection.tsx` | Settings › General 的行；客户端**不** import `lib/network-proxy`（那边依赖 `node:child_process` 与 undici，不能进 client bundle），接口形状在组件里就地声明 |
| `instrumentation-node.ts` | 启动时 `applyNetworkProxy()`（排在 `configureHttpDispatcher()` 之后） |

## 三档语义（对齐 cc-haha 的 direct / system / manual；**默认 direct**）

- **direct**：不走代理，且**忽略**外部环境变量 —— 实现是 `NO_PROXY=*`。少了这一步，从带
  `HTTPS_PROXY` 的 shell 里启动的桌面端会出现「设了直连却还在走代理」。
- **system**：Windows 读注册表 `HKCU\...\Internet Settings` 的 `ProxyEnable`/`ProxyServer`
  （`reg query`，分协议时优先 `https=`），macOS 走 `scutil --proxy`（优先 HTTPS），其它平台
  回落环境变量。探测失败或系统没配 → 等价直连，但**保留**用户自己的 `NO_PROXY` 条目。
- **manual**：用户填的地址，`host:port` 会补成 `http://host:port`；只接受 http/https，
  SOCKS 与 PAC 明确不支持（undici 也不支持）。`manual` 档缺 URL 时 **400**，不静默回落 ——
  否则用户会看到「保存了但没生效」。

默认 `direct` 是有意的：不配就不改变任何行为。若默认 `system`，本机探测到 Clash 之类的
系统代理就会**在用户不知情时把全部出站流量改道**。

`NO_PROXY` 永远包含 `localhost,127.0.0.1,::1`：那是**目标**的回环豁免，与代理本身是不是
本机（Clash 常见的 `127.0.0.1:7890`）无关。

**外部带来的 `NO_PROXY=*` 必须剔除**（`noProxyList`）：`*` 是「所有主机都不代理」的
通配，原样并进去会让 `manual`/`system` 档一个请求都代理不出去 —— 本机真实环境恰好就是
`NO_PROXY=*`，实测过「设置显示生效中、实际仍然直连」。

## 为什么还要换掉全局 `fetch`（最容易漏的一步）

只 `setGlobalDispatcher` **在真实服务端里不生效**。原因：Next 在服务端启动早期用自己的
补丁版覆盖了 `globalThis.fetch`（`next/dist/server/lib/patch-fetch.js` 的 `patchFetch()`，
用 `globalThis[NEXT_PATCH_SYMBOL]` 做哨兵、只补一次），而它包装的是 **Node 内建**的 fetch，
读的是 Node 内建 undici 的 dispatcher —— 跟我们 `node_modules/undici` 这个 npm 包毫无关系。

实测（`?debug=1` 探针 + `NODE_OPTIONS=--require` 记录）：只装 dispatcher 时，把 `manual`
指向一个**死端口**，技能市场的实时源照样 200 成功；换成 undici 包自己的 fetch 之后同样的
请求立刻 502。

所以 `applyNetworkProxy()` 在 `activeProxy !== null` 时调 `applyGlobalFetchForProxy(true)`：
把 `globalThis.fetch` 换成 `undici.fetch`，并记下原来的那个；切回 direct 时恢复。代价是
Next 那层补丁（dedupe / 请求内 trace / `next: { revalidate }` 缓存）在代理开启期间不生效；
本仓 route 全是 `force-dynamic` 且不用 `next:` 选项，所以可接受，也正因如此**只在真的配了
代理时才换**。

只换 `fetch` 一个全局，不用 `undici.install()`：后者会把 `Headers` / `Response` / `Request`
/ `WebSocket` 一起换掉，出现两套类会让 Next 与中继里的 `instanceof` 判断错乱。

## 行为要点

- **改完立即生效**，不需要重启：`applyNetworkProxy()` 写环境变量、重装 dispatcher、必要时
  换掉全局 fetch。旧 dispatcher 用 `close()`（优雅）替换 —— 在跑的那条模型流会正常收完，
  只是不再接新连接。**绝不要**改成 `destroy()`，那会在用户切档位的瞬间把正在输出的回复掐断。
- **生效范围**：同进程的所有出站请求（模型调用、技能市场/插件下载、技能安装）都走它；
  子进程（MCP server、`npx`）继承环境变量。
- **不生效范围**：应用自身的更新检查与安装包下载 —— 那条路走 Rust 的 tauri updater，
  是另一个进程，不读这里写的变量。界面文案里写明了这点（刻意不做，避免与 cc-haha 一样
  出现两个互相矛盾的「代理」设置项）。
- **不做 per-provider 覆盖**（cc-haha 有 `settings.providers.proxyMode`）：本仓的 provider
  配置在 `~/.pi/agent/models.json`，多一层覆盖多于收益，需要时再说。

## 测试

- `lib/network-proxy.test.mjs`：解析器（Windows 注册表文本 / macOS `scutil` 文本）、
  设置读写与坏值回落、`resolveProxyEnv` 的三种语义（含 `NO_PROXY=*` 必须被剔除），以及
  **端到端**：把 `manual` 指向一个本地假代理，断言全局 `fetch` 真的打到它上面、切回 direct
  后恢复原 fetch。
- `app/api/network-proxy/route.test.mjs`：GET 形状、PUT 校验、中继请求 403。
- `lib/http-dispatcher.test.mjs`：`force` 换实例 + `applyGlobalFetchForProxy` 的换/还原，
  证明「改完立即生效」靠的是实例语义而不是侥幸。
