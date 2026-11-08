# 远程访问：映射一个端口，浏览器打开就能用 Pi Agent UI（中文）

> 目标：在电脑上跑 Pi Agent 桌面端，**把它的 Web UI 通过一个端口映射出去**，手机/外部浏览器
> 打开一个网址就能用完整 UI（聊天、终端、会话）。
>
> 本文基于 `D:\GitHub\pi-agent-desktop`（agegr/pi-web 的 fork）。日期 2026-11-05。
> 英文原版设计见 `docs/remote-relay.md` 与 `docs/remote-relay-deploy.md`。

## 0. 结论（先看这里）

| 你想要 | 选 | 代价 |
|---|---|---|
| 最快能跑起来，5–10 分钟，一个端口搞定 | **方案 A：LAN 模式 + 隧道** | 只有一道口令门；拿到网址+口令的人 = 拿到了你电脑的 shell 和文件 |
| 端到端加密、不开任何入站端口、手机逐台配对 | **方案 C：上游 relay** | 需要一台公网服务器 + 两个域名 + 一个静态入口站点 |
| 手机和电脑都在你自己的 Tailscale 网络里 | 方案 B：Tailscale Serve | 需要装 Tailscale 并登录同一 tailnet |

**最短路径就是方案 A。** 方案 B/C 是"更安全但更麻烦"的升级。三者互不冲突，A 可以随时升级到 C。
`remote-gateway/`（早期自研网关）**已删除**，见文末 §5。

---

## 1. 方案 A：LAN 模式 + 隧道（最短路径）

原理：让 Pi 的 Web 服务监听 `0.0.0.0:30141`（而不是只监听本机 127.0.0.1），再用一个隧道程序
把这个本机端口映射成一个公网 HTTPS 网址。手机浏览器打开网址即可。

### 1.1 前置

- Node ≥ 22.19（本人实测 Node 24.15.0 也可）
- 仓库依赖已安装：`cd D:/GitHub/pi-agent-desktop && npm install`

### 1.2 在电脑上启动（关键：必须带口令）

`dev:lan` / `start:lan` 会监听 `0.0.0.0:30141`，并给服务打上"已对外暴露"的标记（某些只该在本机跑的
能力会因此关闭）。

```bash
cd D:/GitHub/pi-agent-desktop

# 开发模式（无需构建，验证用）
PI_WEB_PASSWORD='换成一个足够长、随机的口令' PI_WEB_ALLOWED_HOSTS='pi.你的域名.com' npm run dev:lan

# 生产模式（先构建一次；升级后需重新构建）
npm run build
PI_WEB_PASSWORD='换成一个足够长、随机的口令' PI_WEB_ALLOWED_HOSTS='pi.你的域名.com' npm run start:lan
```

- 不带 `PI_WEB_PASSWORD` 时，启动器会**直接拒绝**在任何非环回地址上监听（已实测，退出码 1，提示
  `Refusing to listen on 0.0.0.0 without authentication`）。这是刻意设计，不要用
  `PI_WEB_ALLOW_UNAUTHENTICATED=1` 绕过。
- 端口固定 `30141`（`scripts/lan-server.mjs` 里写死的 `-p 30141`）。要换端口用 npm 包入口：
  `node bin/pi-web.js -H 0.0.0.0 -p 8080`（需要已有 `.next` 构建产物）。

### 1.3 把端口映射出去（隧道）

隧道程序连的是**本机** `http://127.0.0.1:30141`，不需要在路由器上开端口。

**推荐：cloudflared 命名隧道 + 自有域名**（域名固定，回源 Host 稳定，免费 HTTPS）

```bash
cloudflared tunnel login
cloudflared tunnel create pi
cloudflared tunnel route dns pi pi.你的域名.com
cloudflared tunnel run pi
```

`~/.cloudflared/config.yml` 里配置回源：

```yaml
tunnel: pi
credentials-file: C:\Users\<你>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: pi.你的域名.com
    service: http://127.0.0.1:30141
  - service: http_status:404
```

**临时试跑：cloudflared 快速隧道**（域名每次随机，见 §1.4 的坑）

```bash
cloudflared tunnel --url http://127.0.0.1:30141
# 输出形如 https://random-words.trycloudflare.com
```

**备选：frp**（需要自己的服务器；`type = http` + `custom_domains = pi.你的域名.com`）

### 1.4 关键约束：`PI_WEB_ALLOWED_HOSTS`（必须设）

Pi 有一个 Host 白名单校验（防止 DNS rebinding 等）。规则（已实测）：

- 环回名/IP（`127.0.0.1`、`localhost`）—— 只认来自本机的请求；
- **IP 字面量** —— 当服务监听在环回以外时放行（所以局域网直连 IP 可用）；
- **其它 DNS 域名** —— 必须在 `PI_WEB_ALLOWED_HOSTS` 里逐个列出，否则一律 **403**。

所以：

- 命令里的 `PI_WEB_ALLOWED_HOSTS='pi.你的域名.com'` 就是隧道的公共域名，**必须写**。
- 用**快速隧道**会很别扭：域名每次随机，`PI_WEB_ALLOWED_HOSTS` 是启动时读的，你只能先开隧道拿到
  随机域名、再带着它重启服务。所以**优先选命名隧道 + 自有域名**。
- 若你的隧道工具支持"改写回源 Host"（Cloudflare 的 origin 参数 `httpHostHeader`、frp 的 host
  header rewrite），理论上可以省掉白名单条目；但本机实测的稳妥做法就是**把公共域名写进白名单**。

### 1.5 用手机打开

浏览器访问 `https://pi.你的域名.com` → 首次会要求输入口令（口令错误会被限流）→ 输入后即得完整
Pi Agent UI。iPhone 可"添加到主屏幕"当 PWA 用。

### 1.6 安全注意（务必逐条看）

1. **必须设强口令。** 未设口令时服务拒绝对外监听；不要用 `PI_WEB_ALLOW_UNAUTHENTICATED=1`。
2. **口令是明文 HTTP 传输的**，隧道必须是 HTTPS（cloudflared 自动签证书）。**绝不要**用明文隧道
   或裸 `frp tcp` 把 30141 暴露到公网。
3. **URL + 口令 = 完整所有权**：任何能到达该端口的人都能像你本人一样跑 shell、读文件。把网址当秘密。
4. **建议在隧道前再加一层身份**：Cloudflare Access / Zero Trust，多一道登录才到 Pi 的口令门。
5. 失败口令是**全局限流**的（429，带 `Retry-After`）；会话空闲 10 分钟回收，可用
   `PI_WEB_IDLE_TIMEOUT_MS` 调整。
6. 隧道会保留公共域名作为回源 Host；同源 API 调用（浏览器 fetch）在隧道后**实测可用**（Pi 会识别
   `Origin` + `Sec-Fetch-Site: same-origin`）。

### 1.7 本次实测记录（本地，2026-11-05）

| 检查 | 命令 / 动作 | 结果 |
|---|---|---|
| 监听在 0.0.0.0 | `netstat -ano \| grep 30141` | `0.0.0.0:30141 LISTENING` ✓ |
| 无口令拒绝监听 | `node scripts/lan-server.mjs start`（无 env） | 退出码 1，`Refusing to listen…` ✓ |
| 未登录访问首页 | `curl http://127.0.0.1:30141/` | `307 → /login` ✓ |
| 未登录访问 API | `curl /api/sessions` | `401` ✓ |
| 登录页可访问 | `curl /login` | `200` ✓ |
| 口令登录换 Cookie | `POST /api/web-auth {"password":…}` | `200` + `Set-Cookie: pi_web_session` ✓ |
| 带 Cookie 进 UI | `curl -b cookie /` | `200`，`<title>Pi Agent</title>`，40 KB ✓ |
| 带 Cookie 调 API | `curl -b cookie /api/sessions` | `200` ✓ |
| 局域网 IP 可达 | `curl http://100.100.100.13:30141/login` | `200` ✓ |
| 白名单外域名 | `curl -H 'Host: evil.example.com' /login` | `403` ✓ |
| 白名单内域名 | `PI_WEB_ALLOWED_HOSTS=pi.mydomain.com` 后 `curl -H 'Host: pi.mydomain.com' /login` | `200` ✓（隧道场景） |
| 隧道同源 API | 上面域名 + `Origin: https://pi.mydomain.com` + `Sec-Fetch-Site: same-origin` + Cookie | `200` ✓ |
| 上游单测 | `node --test scripts/lan-server.test.mjs` | 3/3 通过 ✓ |

---

## 2. 方案 C：上游 relay（端到端加密，推荐用于"随时随地"）

上游已内置完整实现（Noise IK/IKpsk2 + 配对 QR + tunnel service worker + relay-shell PWA），
并有 `e2e/relay.mjs` 端到端测试。**电脑不开任何端口**，只主动外连 relay；relay 只转发密文，
看不到内容、路径、请求体。手机浏览器打开入口域名即得完整 UI。

### 2.1 部署前置清单（需你操作，我没实际申请/部署）

- **一台有公网 IP 的小服务器**：香港轻量机免备案；大陆机需先备案域名才能上 HTTPS。
  1 CPU / 1 GB 足够（relay 只转发字节）。
- **一个域名，两个子域**：
  - `relay.你的域名.com` —— relay 本体（HTTPS 上的 WebSocket）；
  - `pi.你的域名.com` —— **入口站点**，服务手机壳（静态文件）。
- **Docker + Docker Compose**（或不用 Docker，用 `npm ci --omit=dev && node server.mjs` 配任意 TLS 反代）。
- **入口站点**（推荐与 relay **分离**的静态托管，如 GitHub Pages / Cloudflare Pages / 对象存储）：
  因为它承载手机端密钥代码，relay 被攻破也不能篡改它。入口域名根路径**不能放别的东西**。
- 手机：iOS 17+（WebCrypto X25519）或较新 Chrome。
- 电脑端：Pi 保持运行（开机自启 + 常驻托盘）。

部署步骤（照做，摘自 `docs/remote-relay-deploy.md`）：

```bash
# 服务器上
git clone <本仓库> pi && cd pi/relay
cat > .env <<EOF
RELAY_DOMAIN=relay.你的域名.com
RELAY_ADMIN_TOKEN=$(openssl rand -hex 32)
EOF
docker compose up -d          # Caddy 自动签 HTTPS 证书
# 验证：https://relay.你的域名.com/healthz → {"ok":true,...}

# 电脑上构建手机壳，把产物传到入口站点根目录
cd D:/GitHub/pi-agent-desktop
npm run relay:shell           # → relay-shell/dist/
```

然后在**电脑上**：设置 › 通用 › **Remote relay**，填 relay 地址（`wss://relay.…`）、入口地址
（`https://pi.…`）、admin token（仅用一次）→ 打开开关。再在设置里"显示 QR 码"，手机扫码配对，
电脑上点"允许"。

### 2.2 本地可验证部分（我已实测）

| 检查 | 命令 | 结果 |
|---|---|---|
| 手机壳可构建 | `npm run relay:shell` | 成功，产物 `relay-shell/dist/`（含 `__shell/shell-<build>.js`（内容 hash 命名）、`tunnel-sw.js`、manifest、图标）✓ |
| relay 服务端单测 | `cd relay && node --test server.test.mjs` | 16/16 通过 ✓ |

（无法本地验证的：真实服务器 + 域名 + Caddy 发证书 + Docker 构建 + 真机 iPhone —— 需要你操作。）

### 2.3 与方案 A 的关系 & 推荐路径

- **A 与 C 是并列的两条路**，都产出"浏览器打开就能用"，但信任模型相反：
  - A：暴露整个端口，一道口令；隧道商/中间人能看到明文 HTTP 内容；简单。
  - C：不暴露端口、端到端加密、逐设备密钥配对；relay 商看不到内容；但要服务器+域名+入口站。
- 方案 B（Tailscale）与 C 是"手机远程"的两条路线；上游文档明确说 **C 取代 B 作为手机跟随/驱动会话的主路径**，B 保留为选项。
- **推荐路径**：先用 A 拿到"现在就能用"的体验；一旦要"随时随地 + 不想让隧道商看到内容"，
  就上 C。若你已有闲置公网服务器和域名，可直接上 C。

---

## 3. 方案 B：Tailscale Serve（简述，备选）

在电脑装 Tailscale 登录 tailnet，`tailscale serve` 把
`https://<机器>.<tailnet>.ts.net` 反代到本机 `127.0.0.1:30141`。服务仍只听环回，端口不开公网。
Pi 侧：设置 › 通用 › **Remote access** 里填入这个 tailnet 主机名并勾选允许的登录账号。
注意：**Funnel（公网）流量会被拒绝**（无口令时 403），必须用 `tailscale serve`（tailnet 内），
且请求要带 `Tailscale-User-Login`。相关实现：`lib/remote-access.ts`、`components/RemoteAccessSection.tsx`。

---

## 4. 三种方案速查表

| 维度 | A：LAN + 隧道 | B：Tailscale Serve | C：上游 relay |
|---|---|---|---|
| 需要公网服务器 | 不需要（用第三方隧道） | 不需要 | 需要 |
| 需要域名 | 命名隧道需要；快速隧道不需要 | 不需要（用 ts.net） | 需要两个 |
| 开入站端口 | 不开（隧道出站） | 不开 | 不开 |
| 传输加密 | TLS（隧道终止），回源明文 HTTP | TLS（tailnet） | Noise 端到端 + TLS |
| 认证方式 | 单一 Web 口令 | Tailscale 登录 | 逐设备密钥配对 |
| 隧道商能看到内容 | 能（明文 HTTP 回源） | 否 | 否（只有密文） |
| 上手成本 | 最低 | 中 | 高 |
| 适用 | 快速自用、可信网络 | 团队 tailnet | 随时随地、重隐私 |

---

## 5. `remote-gateway/` 已删除

背景：`remote-gateway/` 是早期参照 cc-haha 自研的受限网关（`src/` + `test/` + `public/index.html`）。
用户已拍板远程走"上游 relay + LAN 模式"，**不再自研网关、不兼容 cc-haha**，故该目录整体废弃。
它未被任何被跟踪文件引用（已 grep 确认），且整个目录处于 **git 未跟踪**状态，删除安全。
**该目录及其残留已删除。**

**保留（已移到 pi-web）：**

- `remote-gateway/public/lane-diagram.html` → **唯一要留的东西**，已移到 pi-web 的
  `public/lane-diagram.html`，供任务 #7"泳道图 UI"使用。

**已删除：**

- `remote-gateway/src/`（`config.ts`、`forward.ts`、`pairing.ts`、`security.ts`、`server.ts`、
  `store.ts`、`tokens.ts`、`tunnel.ts`、`types.ts`）
- `remote-gateway/test/pairing.test.mjs`
- `remote-gateway/public/index.html`（自研 H5 配对页，已被上游 `relay-shell/` 取代）
- `remote-gateway/package.json`、`package-lock.json`、`tsconfig.json`
- `remote-gateway/node_modules/`

**另外：**

- `docs/remote-gateway-design.md`（面向 cc-haha 的设计草案）→ 已被 `docs/remote-relay.md` +
  `docs/remote-relay-deploy.md` + 本文覆盖，**已删除。**
- `remote-gateway/` 不在 `package.json` 的 workspaces / CI 里（保持原样）。
