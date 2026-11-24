import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * SSRF 防线的「本体」——收窄之后仍然必须成立的几条。
 *
 * 背景：操作者填 `http://127.0.0.1:8787/v1` 添加本地模型服务时被
 * 「Base URL cannot point at a local or private network address」挡住。那条拒绝的
 * **真意图**是「本机已存的 API key 不能被带到攻击者挑的主机上去」，而首次添加本地
 * provider 根本没有已存端点、也不花已存凭据——挡住它只误伤了本机服务，什么也没保护。
 *
 * 现在的边界：**只有当这一请求会花掉本机已存凭据时**，新引入的私网/环回目标才拒绝。
 * 这个文件钉住的是那条防线还在：
 * 1. provider 已存端点 A（公网或别的地址），请求把它指向 loopback ⇒ 仍 400；
 * 2. 请求自带 apiKey（不花已存凭据）指向 loopback ⇒ 放行；
 * 3. scheme 检查始终在（file:// 一律 400）；
 * 4. 已存端点自身是 loopback（本机 Ollama）⇒ 依然放行。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const target = await jiti.import("./model-discovery-target.ts");

test("a stored endpoint makes a new loopback target refusable (the credential-exfiltration shape)", () => {
  const requested = ["http://127.0.0.1:8787/v1"];
  const saved = "https://api.example.com/v1";
  // The request would spend this machine's stored key against a host the caller chose.
  assert.equal(target.disallowsStoredDiscoveryAuth(requested, saved), true);
  // …and that is exactly the case where the private-address guard must bite.
  const allowPrivate = target.isSameDiscoveryBaseUrl(requested[0], saved);
  assert.equal(allowPrivate, false);
  assert.equal(target.validateDiscoveryBaseUrl(requested[0], { allowPrivate }), "Base URL cannot point at a local or private network address");
});

test("a request that brings its own key may target loopback (local model server)", () => {
  // The route reaches `allowPrivate` through `useStoredAuth`, which is false whenever
  // the request supplies its own apiKey. What this file pins is the decision the route
  // makes from that flag: with no stored credential to spend, a loopback target is
  // allowed. (The route-level consequence is covered in the discover/test route tests.)
  assert.equal(target.validateDiscoveryBaseUrl("http://127.0.0.1:8787/v1", { allowPrivate: true }), null);
  // A saved endpoint elsewhere still makes this same URL a credential-exfiltration shape.
  assert.equal(target.disallowsStoredDiscoveryAuth(["http://127.0.0.1:8787/v1"], "https://api.example.com/v1"), true);
});

test("a provider whose saved endpoint *is* loopback keeps working (local Ollama)", () => {
  const url = "http://127.0.0.1:11434/v1";
  assert.equal(target.isSameDiscoveryBaseUrl(url, url), true);
  assert.equal(target.validateDiscoveryBaseUrl(url, { allowPrivate: true }), null);
  // Trailing slash is not a different endpoint.
  assert.equal(target.isSameDiscoveryBaseUrl("http://127.0.0.1:11434/v1/", url), true);
});

test("the scheme check never relaxes, even when a private target is allowed", () => {
  for (const url of ["file:///etc/passwd", "ftp://127.0.0.1/x", "javascript:alert(1)"]) {
    assert.equal(
      target.validateDiscoveryBaseUrl(url, { allowPrivate: true }),
      "Only http and https Base URLs are allowed",
      `${url} must still be refused`,
    );
  }
});

test("private and loopback literals are still detected (IPv4 and IPv6 forms)", () => {
  for (const url of [
    "http://10.0.0.5/v1",
    "http://192.168.1.10/v1",
    "http://172.16.4.4/v1",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/v1",
    "http://[::ffff:7f00:1]/v1",
    "http://[fd00::1]/v1",
    "http://localhost:1234/v1",
  ]) {
    assert.equal(
      target.validateDiscoveryBaseUrl(url, {}),
      "Base URL cannot point at a local or private network address",
      `${url} must be treated as private`,
    );
  }
  // A public literal is still fine.
  assert.equal(target.validateDiscoveryBaseUrl("https://api.example.com/v1", {}), null);
});
