import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const pa = await import("./settings.ts");

const TUNNEL_ID = "12345678-1234-1234-1234-123456789012";
const TOKEN = Buffer.from(JSON.stringify({ a: "acct", t: TUNNEL_ID, s: Buffer.from("shh").toString("base64") })).toString("base64");

function settingsPath() {
  const dir = mkdtempSync(join(tmpdir(), "pi-public-access-"));
  const path = join(dir, "pi-web", "settings.json");
  mkdirSync(join(dir, "pi-web"), { recursive: true });
  return { dir, path };
}

const BASE = {
  enabled: false, mode: "quick", localPort: pa.DEFAULT_PUBLIC_ACCESS_PORT,
  token: "", customUrl: "", autoStart: false, consentVersion: 0, origin: "",
};

test("normalizePublicAccessOrigin：只收 https origin", () => {
  assert.equal(pa.normalizePublicAccessOrigin("https://pi.example.com"), "https://pi.example.com");
  assert.equal(pa.normalizePublicAccessOrigin("https://PI.example.com/"), "https://pi.example.com");
  for (const rejected of [
    "http://pi.example.com", "https://pi.example.com/path", "https://pi.example.com/?q=1",
    "https://user:pw@pi.example.com", "https://pi.example.com#f", "ftp://pi.example.com",
    "", "nope", null, 42,
  ]) {
    assert.equal(pa.normalizePublicAccessOrigin(rejected), null, String(rejected));
  }
});

test("isLocalPort / isCloudflareTunnelToken 边界", () => {
  assert.equal(pa.isLocalPort(1024), true);
  assert.equal(pa.isLocalPort(65535), true);
  for (const bad of [80, 1023, 65536, 3014.5, "30141", null]) assert.equal(pa.isLocalPort(bad), false, String(bad));
  assert.equal(pa.isCloudflareTunnelToken(""), true);
  assert.equal(pa.isCloudflareTunnelToken(TOKEN), true);
  for (const bad of ["short", "has space", "a".repeat(20), 123, null]) assert.equal(pa.isCloudflareTunnelToken(bad), false, String(bad));
});

test("读 token 只暴露 tunnelId；从文本里能抠出 token 并识别歧义", () => {
  assert.deepEqual(pa.readCloudflareTunnelToken(TOKEN), { tunnelId: TUNNEL_ID });
  assert.equal(pa.readCloudflareTunnelToken("not-base64!!"), null);
  assert.equal(pa.readCloudflareTunnelToken(Buffer.from("{}").toString("base64")), null);

  const found = pa.findCloudflareTunnelToken(`cloudflared service install ${TOKEN}`);
  assert.equal(found.status, "found");
  assert.equal(found.tunnelId, TUNNEL_ID);
  assert.equal(pa.findCloudflareTunnelToken("no token here").status, "missing");
  const other = Buffer.from(JSON.stringify({ a: "a", t: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", s: "Zm9v" })).toString("base64");
  assert.equal(pa.findCloudflareTunnelToken(`${TOKEN} ${other}`).status, "ambiguous");
});

test("读写配置保留同文件其它键；token 与 origin 分开管理", () => {
  const { dir, path } = settingsPath();
  try {
    assert.deepEqual(pa.readPublicAccessConfig(path), BASE);

    const saved = pa.writePublicAccessConfig(
      { ...pa.readPublicAccessConfig(path), enabled: true, mode: "named", token: TOKEN, localPort: 30141 },
      path,
    );
    assert.equal(saved.mode, "named");
    assert.equal(saved.token, TOKEN);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(stored.version, 1);

    // 其它键不被抹掉
    writeFileSync(path, JSON.stringify({ ...stored, artifactsPrompt: false, remoteAccess: { hostname: "mac.ts.net" } }));
    pa.writePublicAccessConfig({ ...pa.readPublicAccessConfig(path), autoStart: true }, path);
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(after.artifactsPrompt, false);
    assert.deepEqual(after.remoteAccess, { hostname: "mac.ts.net" });

    assert.equal(pa.readPublicAccessOrigin(path), null);
    pa.writePublicAccessOrigin("https://quick.trycloudflare.com/", path);
    assert.equal(pa.readPublicAccessOrigin(path), "https://quick.trycloudflare.com");
    pa.writePublicAccessOrigin(null, path);
    assert.equal(pa.readPublicAccessOrigin(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isPublicAccessConfigured：named 必须有 token", () => {
  assert.equal(pa.isPublicAccessConfigured({ ...BASE, mode: "quick" }), true);
  assert.equal(pa.isPublicAccessConfigured({ ...BASE, mode: "named", token: "" }), false);
  assert.equal(pa.isPublicAccessConfigured({ ...BASE, mode: "named", token: TOKEN }), true);
});

test("parsePublicAccessUpdate：省略 token 保留原值，非法输入报错", () => {
  const current = {
    enabled: true, mode: "named", localPort: 30141, token: TOKEN,
    customUrl: "", autoStart: false, consentVersion: 1, origin: "",
  };
  const kept = pa.parsePublicAccessUpdate({ localPort: 40000 }, current);
  assert.equal(kept.ok, true);
  assert.equal(kept.config.token, TOKEN, "省略 token 不得清空已存凭据");
  assert.equal(kept.config.localPort, 40000);

  assert.equal(pa.parsePublicAccessUpdate({ localPort: 80 }, current).ok, false);
  assert.equal(pa.parsePublicAccessUpdate({ mode: "ngrok" }, current).ok, false);
  assert.equal(pa.parsePublicAccessUpdate({ token: "short" }, current).ok, false);
  assert.equal(pa.parsePublicAccessUpdate({ mode: "named", customUrl: "http://x.example.com" }, current).ok, false);
  assert.equal(pa.parsePublicAccessUpdate({ mode: "named", token: "", customUrl: "" }, { ...current, token: "" }).ok, false);
  assert.equal(pa.parsePublicAccessUpdate(null, current).ok, false);

  const quick = pa.parsePublicAccessUpdate({ mode: "quick", customUrl: "https://ignored.example.com" }, current);
  assert.equal(quick.ok, true);
  assert.equal(quick.config.customUrl, "", "quick 模式不接受自定义域名");
});

test("isPublicAccessRequestHost：只认当前 origin 的域名", () => {
  const config = { ...BASE, origin: "https://pi.example.com" };
  const hit = new Request("http://127.0.0.1:30141/", { headers: { host: "pi.example.com" } });
  const miss = new Request("http://127.0.0.1:30141/", { headers: { host: "evil.example.com" } });
  assert.equal(pa.isPublicAccessRequestHost(hit, config), true);
  assert.equal(pa.isPublicAccessRequestHost(miss, config), false);
  assert.equal(pa.isPublicAccessRequestHost(hit, { ...config, origin: "" }), false);
});
