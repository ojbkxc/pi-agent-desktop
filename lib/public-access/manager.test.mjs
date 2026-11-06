import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { PublicAccessManager, classifyPublicAccessError } = await import("./manager.ts");
const settings = await import("./settings.ts");

const PORT = 30141;
const ENV = { PI_WEB_PASSWORD: "pw" };

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "pi-pa-manager-"));
  mkdirSync(join(dir, "pi-web"), { recursive: true });
  return join(dir, "pi-web", "settings.json");
}

function seed(path, patch = {}) {
  return settings.writePublicAccessConfig(
    { ...settings.readPublicAccessConfig(path), mode: "quick", autoStart: false, ...patch },
    path,
  );
}

function fakeTunnel({ url = "https://calm-river.trycloudflare.com", failStop = false } = {}) {
  const exits = new Set();
  return {
    url,
    stopCalls: 0,
    async stop() {
      this.stopCalls += 1;
      if (failStop) throw new Error("cannot stop the connector");
    },
    async publishedRoutes() { return []; },
    onExit(callback) { exits.add(callback); return () => exits.delete(callback); },
    emitExit() { for (const callback of [...exits]) callback({ code: 0, signal: null }); },
  };
}

function manager(path, extra = {}) {
  const tunnel = extra.tunnel ?? fakeTunnel();
  return {
    tunnel,
    instance: new PublicAccessManager({
      settingsPath: path,
      localPort: () => PORT,
      env: ENV,
      startTunnel: async () => tunnel,
      verify: async () => true,
      ...extra.overrides,
    }),
  };
}

test("happy path：启动 → 验证 → online，并把 origin 写进设置文件", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  const { instance } = manager(path);

  const status = await instance.start();
  assert.equal(status.state, "online");
  assert.equal(status.publicUrl, "https://calm-river.trycloudflare.com");
  assert.equal(settings.readPublicAccessOrigin(path), "https://calm-river.trycloudflare.com");
  assert.equal(instance.getView().tokenSet, false);

  await instance.stop();
  assert.equal(instance.getStatus().state, "disabled");
  assert.equal(settings.readPublicAccessOrigin(path), null, "停止后 origin 必须清空");
});

test("没设 web 密码时不启动（也不写 origin）", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  const { instance } = manager(path, { overrides: { env: {} } });
  assert.throws(() => instance.start(), /PI_WEB_PASSWORD/);
  assert.equal(settings.readPublicAccessOrigin(path), null);
});

test("公网校验失败 → 归类 network 并进入重连，且 origin 被清掉", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  let verifyCalls = 0;
  const { instance } = manager(path, { overrides: { verify: async () => { verifyCalls += 1; return false; } } });
  const status = await instance.start();
  assert.equal(status.state, "reconnecting", "network 类错误会退避重试");
  assert.equal(status.error, "network");
  assert.equal(instance.getStatus().publicUrl, null);
  assert.equal(verifyCalls, 3, "最多三次校验");
  assert.equal(settings.readPublicAccessOrigin(path), null);
  await instance.stop();
});

test("连接器异常退出且仍想在线 → 进入 reconnecting", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  const { instance, tunnel } = manager(path);
  await instance.start();
  tunnel.emitExit();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(instance.getStatus().state, "reconnecting");
  await instance.stop();
  assert.equal(instance.getStatus().state, "disabled");
});

test("停止无法确认 → failed(stop)，且阻止再次启动", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  const { instance } = manager(path, { tunnel: fakeTunnel({ failStop: true }) });
  await instance.start();
  const status = await instance.stop();
  assert.equal(status.state, "failed");
  assert.equal(status.error, "stop");
  await assert.rejects(instance.start(), /stop must be confirmed/);
});

test("configure 会停隧道并把同意版本归零", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  const { instance, tunnel } = manager(path);
  await instance.start();
  const current = settings.readPublicAccessConfig(path);
  const view = await instance.configure({ ...current, enabled: true, mode: "named", token: "x".repeat(40) });
  assert.equal(view.consentVersion, 0);
  assert.equal(view.mode, "named");
  assert.equal(tunnel.stopCalls, 1);
  assert.equal(settings.readPublicAccessOrigin(path), null);
});

test("restore：只有 autoStart + 同意过 + 有密码才自启", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));

  seed(path, { autoStart: false });
  const idle = manager(path).instance;
  await idle.restore();
  assert.equal(idle.getStatus().state, "disabled");

  seed(path, { autoStart: true });
  const noConsent = manager(path).instance;
  await noConsent.restore();
  assert.equal(noConsent.getStatus().state, "disabled", "没同意过不启动");

  seed(path, { autoStart: true, consentVersion: settings.PUBLIC_ACCESS_CONSENT_VERSION });
  const restored = manager(path).instance;
  await restored.restore();
  assert.equal(restored.getStatus().state, "online");
  await restored.stop();

  const withoutPassword = manager(path, { overrides: { env: {} } }).instance;
  await withoutPassword.restore();
  assert.equal(withoutPassword.getStatus().state, "disabled", "没密码不自动开洞");
});

test("classifyPublicAccessError：受控 code 原样返回，其余按文案归类", () => {
  assert.equal(classifyPublicAccessError({ code: "token" }), "token");
  assert.equal(classifyPublicAccessError(new Error("EADDRINUSE")), "configuration");
  assert.equal(classifyPublicAccessError(new Error("socket hang up")), "network");
});
