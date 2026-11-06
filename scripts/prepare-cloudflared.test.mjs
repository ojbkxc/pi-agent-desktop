import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const pf = await import("./prepare-cloudflared.mjs");

const PAYLOAD = Buffer.from("pretend this is cloudflared");
const FAKE_TABLE = {
  "fake-triple": { name: "cloudflared-fake.bin", sha256: pf.sha256(PAYLOAD), archive: false },
};

function okFetch(body = PAYLOAD) {
  return async () => ({ ok: true, status: 200, arrayBuffer: async () => body });
}

test("target triple 与资产名映射", () => {
  assert.equal(pf.cloudflaredTargetTriple("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(pf.cloudflaredTargetTriple("win32", "arm64"), "aarch64-pc-windows-msvc");
  assert.equal(pf.cloudflaredTargetTriple("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(pf.cloudflaredTargetTriple("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(pf.bundledCloudflaredName("x86_64-pc-windows-msvc"), "cloudflared-x86_64-pc-windows-msvc.exe");
  assert.equal(pf.bundledCloudflaredName("aarch64-apple-darwin"), "cloudflared-aarch64-apple-darwin");
  assert.match(pf.getCloudflaredDownloadUrl("x86_64-unknown-linux-gnu"), /releases\/download\/2026\.10\.6\/cloudflared-linux-amd64$/);
  assert.throws(() => pf.getCloudflaredAsset("sparc-sun-solaris"), /Unsupported target triple/);
});

test("下载 → 校验 → 原子落盘，并写 manifest", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = await pf.prepareCloudflared({ targetTriple: "fake-triple", directory: dir, assets: FAKE_TABLE, fetch: okFetch() });
  assert.equal(result.source, "download");
  assert.deepEqual(readFileSync(result.path), PAYLOAD);
  const manifest = JSON.parse(readFileSync(`${result.path}.json`, "utf8"));
  assert.equal(manifest.targetTriple, "fake-triple");
  assert.equal(manifest.assetSha256, FAKE_TABLE["fake-triple"].sha256);

  // 二次调用走缓存，不再下载
  let fetches = 0;
  const cached = await pf.prepareCloudflared({
    targetTriple: "fake-triple", directory: dir, assets: FAKE_TABLE,
    fetch: async (...args) => { fetches += 1; return okFetch()(...args); },
  });
  assert.equal(cached.source, "cache");
  assert.equal(fetches, 0);

  assert.equal(await pf.assertPreparedCloudflared("fake-triple", dir, FAKE_TABLE), result.path);
});

test("摘要不符时拒绝落盘", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    pf.prepareCloudflared({ targetTriple: "fake-triple", directory: dir, assets: FAKE_TABLE, fetch: okFetch(Buffer.from("tampered")) }),
    /Checksum mismatch/,
  );
  assert.throws(() => statSync(join(dir, "cloudflared-fake-triple")), /ENOENT/, "失败的下载不留下文件");
});

test("HTTP 失败与缺文件都有明确报错", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    pf.prepareCloudflared({ targetTriple: "fake-triple", directory: dir, assets: FAKE_TABLE, fetch: async () => ({ ok: false, status: 502 }) }),
    /HTTP 502/,
  );
  await assert.rejects(pf.assertPreparedCloudflared("fake-triple", dir, FAKE_TABLE), /not prepared/);
});

test("代理环境变量会转成 undici 的代理 fetch", async () => {
  assert.equal(await pf.proxyDispatcher({}), undefined);
  assert.equal(await pf.proxyFetch({}), undefined);
  const dispatcher = await pf.proxyDispatcher({ HTTPS_PROXY: "http://127.0.0.1:60815" });
  assert.ok(dispatcher, "配置了代理时应返回 dispatcher");
  assert.equal(typeof dispatcher.dispatch, "function");
  assert.equal(typeof await pf.proxyFetch({ http_proxy: "http://127.0.0.1:60815" }), "function");
  assert.equal(await pf.proxyDispatcher({ http_proxy: "   " }), undefined);
});

test("下载失败时带出底层原因", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const failure = Object.assign(new Error("fetch failed"), { cause: new Error("connect ECONNREFUSED 127.0.0.1:60815") });
  await assert.rejects(
    pf.prepareCloudflared({ targetTriple: "fake-triple", directory: dir, assets: FAKE_TABLE, fetch: async () => { throw failure; } }),
    /ECONNREFUSED/,
  );
});
