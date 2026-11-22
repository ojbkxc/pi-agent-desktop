import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * 会话流量的网络代理（`lib/network-proxy.ts`）。
 *
 * 要害有三条，都用断言钉住：
 *   1. 系统探测的解析（Windows 注册表 / macOS scutil 的**文本**形态）；
 *   2. `direct` 要**忽略**外部环境变量（`NO_PROXY=*`），否则从带代理的 shell 启动的
 *      桌面端会「设了直连还在走代理」；`system` 则要保留用户自己的 NO_PROXY 条目；
 *   3. `applyNetworkProxy` 真的把环境变量写给 undici 的 dispatcher 用（端到端打到一个
 *      本地假代理上验证），不是只写了个变量没人读。
 */

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
];

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { "@": process.cwd() } });
const {
  normalizeProxyUrl,
  parseWindowsProxyRegistry,
  parseMacSystemProxy,
  readNetworkProxySettings,
  writeNetworkProxySettings,
  resolveProxyEnv,
  applyNetworkProxy,
  networkProxyStatus,
  stripProxyCredentials,
  LOOPBACK_NO_PROXY_ENTRIES,
} = await jiti.import("./network-proxy.ts");

const root = mkdtempSync(join(tmpdir(), "pi-network-proxy-"));
const settingsPath = join(root, "pi-web", "settings.json");

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 20 });
});

test("normalizeProxyUrl：补协议、只收 http/https", () => {
  assert.equal(normalizeProxyUrl("127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(normalizeProxyUrl("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(normalizeProxyUrl("  https://proxy.example:8080/  "), "https://proxy.example:8080/");
  // SOCKS 与 PAC 明确不支持（undici 的 EnvHttpProxyAgent 也不支持）。
  assert.equal(normalizeProxyUrl("socks5://127.0.0.1:1080"), "");
  assert.equal(normalizeProxyUrl("pac+http://example/proxy.pac"), "");
  assert.equal(normalizeProxyUrl("http://"), "");
  assert.equal(normalizeProxyUrl(""), "");
  assert.equal(normalizeProxyUrl(undefined), "");
  assert.equal(normalizeProxyUrl(42), "");
});

test("Windows 注册表解析：开关、分协议、关掉、只有 PAC", () => {
  const key = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const value = (name, type, data) => `    ${name}    ${type}    ${data}`;
  assert.equal(
    parseWindowsProxyRegistry(`${key}\n${value("ProxyEnable", "REG_DWORD", "0x1")}\n${value("ProxyServer", "REG_SZ", "127.0.0.1:7890")}\n`),
    "http://127.0.0.1:7890",
  );
  // 分协议时优先 https（模型端点都是 HTTPS）。
  assert.equal(
    parseWindowsProxyRegistry(`${key}\n${value("ProxyEnable", "REG_DWORD", "0x1")}\n${value("ProxyServer", "REG_SZ", "http=127.0.0.1:7890;https=127.0.0.1:7891")}\n`),
    "http://127.0.0.1:7891",
  );
  // 系统代理关着 → 没代理，哪怕 ProxyServer 还留着。
  assert.equal(
    parseWindowsProxyRegistry(`${key}\n${value("ProxyEnable", "REG_DWORD", "0x0")}\n${value("ProxyServer", "REG_SZ", "127.0.0.1:7890")}\n`),
    null,
  );
  // 只有 PAC（AutoConfigURL），没有 ProxyServer → 我们处理不了，返回 null。
  assert.equal(
    parseWindowsProxyRegistry(`${key}\n${value("ProxyEnable", "REG_DWORD", "0x1")}\n${value("AutoConfigURL", "REG_SZ", "http://cfg/proxy.pac")}\n`),
    null,
  );
  assert.equal(parseWindowsProxyRegistry(""), null);
});

test("macOS scutil 解析：优先 HTTPS，其次 HTTP", () => {
  const scutil = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
}`;
  assert.equal(parseMacSystemProxy(scutil), "http://127.0.0.1:7891");
  assert.equal(parseMacSystemProxy(scutil.replace("HTTPSEnable : 1", "HTTPSEnable : 0")), "http://127.0.0.1:7890");
  assert.equal(parseMacSystemProxy(scutil.replace(/HTTPSEnable : 1/, "HTTPSEnable : 0").replace("HTTPEnable : 1", "HTTPEnable : 0")), null);
  assert.equal(parseMacSystemProxy(""), null);
});

test("设置读写：只动 networkProxy 一个键，坏值回落 direct", () => {
  writeFileSync(join(root, "seed.json"), JSON.stringify({ version: 1, artifactsPrompt: false }));
  const path = join(root, "seed.json");
  // 文件里没有这个键 → 默认直连：不配就不改变任何行为（默认走系统代理会在用户不知情时
  // 把全部出站流量改道）。
  assert.deepEqual(readNetworkProxySettings(path), { mode: "direct", url: "" });
  assert.deepEqual(writeNetworkProxySettings({ mode: "manual", url: "127.0.0.1:7890" }, path), {
    mode: "manual",
    url: "http://127.0.0.1:7890",
  });
  // 其它键与 url 一起落盘，且 url 已归一化。
  const stored = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(stored.artifactsPrompt, false);
  assert.deepEqual(stored.networkProxy, { mode: "manual", url: "http://127.0.0.1:7890" });
  assert.deepEqual(readNetworkProxySettings(path), { mode: "manual", url: "http://127.0.0.1:7890" });
  // 非法档位/非法 URL 一律回落，不抛。
  writeFileSync(path, JSON.stringify({ networkProxy: { mode: "socks", url: "socks5://x" } }));
  assert.deepEqual(readNetworkProxySettings(path), { mode: "direct", url: "" });
  writeFileSync(path, JSON.stringify({ networkProxy: "manual" }));
  assert.deepEqual(readNetworkProxySettings(path), { mode: "direct", url: "" });
});

test("resolveProxyEnv：direct 忽略外部代理，system 保留用户自己的排除项", () => {
  const env = { HTTPS_PROXY: "http://ambient.example:8080", NO_PROXY: ".corp.example" };
  // direct：连环境里带的代理一起忽略 —— 只有 `*` 能做到。
  assert.deepEqual(resolveProxyEnv({ mode: "direct", url: "" }, null, env), {
    activeProxy: null,
    env: { NO_PROXY: "*" },
  });
  // system 且探测到 → 用探测值，回环与用户条目都在。
  const system = resolveProxyEnv({ mode: "system", url: "" }, "http://127.0.0.1:7890", env);
  assert.equal(system.activeProxy, "http://127.0.0.1:7890");
  assert.equal(system.env.HTTPS_PROXY, "http://127.0.0.1:7890");
  for (const entry of [...LOOPBACK_NO_PROXY_ENTRIES, ".corp.example"]) {
    assert.ok(system.env.NO_PROXY.split(",").includes(entry), `NO_PROXY must keep ${entry}`);
  }
  // system 且探测不到 → 回落环境变量；再没有就是直连，但排除项照旧。
  assert.equal(resolveProxyEnv({ mode: "system", url: "" }, null, env).activeProxy, "http://ambient.example:8080");
  const none = resolveProxyEnv({ mode: "system", url: "" }, null, {});
  assert.equal(none.activeProxy, null);
  assert.equal(none.env.HTTP_PROXY, undefined);
  assert.deepEqual(none.env.NO_PROXY.split(","), [...LOOPBACK_NO_PROXY_ENTRIES]);
  // manual：用填的地址，忽略环境与探测结果。
  assert.equal(resolveProxyEnv({ mode: "manual", url: "http://p:1" }, "http://other:2", env).activeProxy, "http://p:1");
  // manual 但 URL 不可用 → 直连（路由层会先拦掉这种请求）。
  assert.equal(resolveProxyEnv({ mode: "manual", url: "socks5://p:1" }, null, env).activeProxy, null);
  // 外部带来的 `NO_PROXY=*` 必须被剔除：原样并进去会让代理档一个请求都代理不出去
  // （本机真实环境就是 `NO_PROXY=*`，实测时正是它让 manual 档看起来「生效了却没用」）。
  const starry = resolveProxyEnv({ mode: "manual", url: "http://p:1" }, null, { NO_PROXY: "*" });
  assert.equal(starry.activeProxy, "http://p:1");
  assert.ok(!starry.env.NO_PROXY.split(",").includes("*"));
  assert.deepEqual(starry.env.NO_PROXY.split(","), [...LOOPBACK_NO_PROXY_ENTRIES]);
  // system 档回落环境变量时也一样：`*` 不能再把环境里的代理压掉。
  assert.equal(
    resolveProxyEnv({ mode: "system", url: "" }, null, { NO_PROXY: "*", HTTPS_PROXY: "http://ambient:1" }).activeProxy,
    "http://ambient:1",
  );
});

test("代理 URL 的 userinfo 不进环境变量（剥掉凭据再写 env）", () => {
  // 凭据留在设置文件里（用户自己写的本机文件），但环境变量被**每个子进程**继承 ——
  // MCP server、`npx` 装的技能包都能读到 HTTP_PROXY 里的凭据，所以写 env 前必须剥掉。
  const manual = resolveProxyEnv({ mode: "manual", url: "http://user:pass@proxy.example:8080" }, null, {});
  assert.equal(manual.activeProxy, "http://proxy.example:8080/");
  assert.equal(manual.env.HTTP_PROXY, "http://proxy.example:8080/");
  assert.equal(manual.env.HTTPS_PROXY, "http://proxy.example:8080/");
  assert.ok(!String(manual.env.HTTP_PROXY).includes("pass"), "凭据不得出现在 env 里");
  // 口令里未编码的 `@` 也要整体剥掉（userinfo 以 authority 里最后一个 @ 结尾）。
  const rawAt = resolveProxyEnv({ mode: "manual", url: "http://u:p@ss@proxy.example:8080" }, null, {});
  assert.equal(rawAt.env.HTTP_PROXY, "http://proxy.example:8080/");
  // system 档回落环境变量时同样剥（URL 序列化会省掉默认端口 `:80`）。
  const ambient = resolveProxyEnv({ mode: "system", url: "" }, null, { HTTPS_PROXY: "http://u:p@ambient.example:80" });
  assert.equal(ambient.env.HTTPS_PROXY, "http://ambient.example/");
  // 无凭据的 URL 原样通过；解析不动的原样返回（调用点都已归一化过）。
  assert.equal(stripProxyCredentials("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(stripProxyCredentials("not a url"), "not a url");
});

test("networkProxyStatus 只读：不改环境变量，也不装 dispatcher", async () => {
  const env = { NO_PROXY: "keep.me" };
  const statusPath = join(root, "status.json");
  writeFileSync(statusPath, JSON.stringify({ networkProxy: { mode: "manual", url: "http://p:1" } }));
  const status = await networkProxyStatus({ settingsPath: statusPath, env, platform: "linux", local: false });
  assert.equal(status.local, false);
  assert.equal(status.mode, "manual");
  assert.equal(status.activeProxy, "http://p:1");
  assert.equal(status.systemProxy, null);
  assert.deepEqual(env, { NO_PROXY: "keep.me" });
});

test("applyNetworkProxy 真把代理灌给全局 fetch：打到本地假代理上验证", async (t) => {
  const originalEnv = new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  for (const key of PROXY_ENV_KEYS) delete process.env[key];

  const forwarded = [];
  const proxy = createServer((req, res) => {
    forwarded.push(`${req.method} ${req.url}`);
    res.writeHead(204, { Connection: "close" });
    res.end();
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(async () => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => proxy.close(resolve));
  });
  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  const proxyUrl = `http://127.0.0.1:${address.port}`;

  const status = await applyNetworkProxy({ settings: { mode: "manual", url: proxyUrl } });
  assert.equal(status.activeProxy, proxyUrl);
  assert.equal(process.env.HTTPS_PROXY, proxyUrl);
  assert.ok(process.env.NO_PROXY.split(",").includes("127.0.0.1"));

  const response = await fetch("http://target.invalid/through-manual-proxy", {
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 204);
  assert.deepEqual(forwarded, ["GET http://target.invalid/through-manual-proxy"]);

  // 切回直连：环境变量被清掉、全局 fetch 复原，同一个进程里的请求不再走代理。
  const direct = await applyNetworkProxy({ settings: { mode: "direct", url: "" } });
  assert.equal(direct.activeProxy, null);
  assert.equal(process.env.HTTPS_PROXY, undefined);
  assert.equal(process.env.HTTP_PROXY, undefined);
  assert.equal(process.env.NO_PROXY, "*");
  assert.equal(globalThis.fetch, originalFetch, "direct must restore the original fetch");
  await assert.rejects(fetch("http://target.invalid/direct-now", { signal: AbortSignal.timeout(2_000) }));
  assert.equal(forwarded.length, 1);
});

test("networkProxyStatus：远端读取遮蔽手动代理 URL 的凭据，本机保留原样", async () => {
  const path = join(root, "status-manual.json");
  writeNetworkProxySettings({ mode: "manual", url: "http://user:p%40ss@proxy.local:8080" }, path);

  const local = await networkProxyStatus({ settingsPath: path, env: {}, local: true });
  assert.equal(local.local, true);
  assert.match(local.url, /user:p%40ss@/, "本机读到原始（含凭据的）url");

  const remote = await networkProxyStatus({ settingsPath: path, env: {}, local: false });
  assert.equal(remote.local, false);
  assert.doesNotMatch(remote.url, /@/, "远端 url 不带 userinfo");
  assert.doesNotMatch(remote.url, /user/, "远端 url 不含凭据");
  const parsed = new URL(remote.url);
  assert.equal(parsed.username, "");
  assert.equal(parsed.password, "");
});

test("networkProxyStatus：探测到的系统代理，远端也要遮蔽凭据", async () => {
  const path = join(root, "status-system.json");
  writeNetworkProxySettings({ mode: "system", url: "" }, path);
  const run = async () => ({
    stdout: [
      "    ProxyEnable    REG_DWORD    0x1",
      "    ProxyServer    REG_SZ    http://user:pass@sysproxy.local:8080",
    ].join("\r\n"),
  });

  const local = await networkProxyStatus({ settingsPath: path, env: {}, local: true, platform: "win32", run });
  assert.match(String(local.systemProxy), /user:pass@/, "本机保留探测到的系统代理原样");

  const remote = await networkProxyStatus({ settingsPath: path, env: {}, local: false, platform: "win32", run });
  assert.doesNotMatch(String(remote.systemProxy), /@/, "远端系统代理不带 userinfo");
  assert.match(String(remote.systemProxy), /sysproxy\.local:8080/, "仍是同一主机");
});
