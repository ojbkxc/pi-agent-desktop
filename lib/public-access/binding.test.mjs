import assert from "node:assert/strict";
import test from "node:test";

const { classifyDomainBinding, routeCoversHostname } = await import("./binding.ts");

const PORT = 30141;
const CUSTOM = "https://pi.example.com";

test("routeCoversHostname：精确 / 通配 / catch-all", () => {
  assert.equal(routeCoversHostname({ hostname: "pi.example.com" }, "pi.example.com"), true);
  assert.equal(routeCoversHostname({ hostname: "pi.example.com" }, "other.example.com"), false);
  assert.equal(routeCoversHostname({ hostname: "*.example.com" }, "a.example.com"), true);
  assert.equal(routeCoversHostname({ hostname: "*.example.com" }, "example.com"), false, "通配不覆盖裸域名");
  assert.equal(routeCoversHostname({}, "anything.example.com"), true, "空 = catch-all");
});

test("classifyDomainBinding：尚未收到推送 → polling", () => {
  assert.deepEqual(classifyDomainBinding(null, CUSTOM, PORT), { state: "polling", reason: null });
});

test("classifyDomainBinding：域名路由指向本机网关 → bound（preferred 优先）", () => {
  const routes = [
    { hostname: "pi.example.com", service: "http://127.0.0.1:30141" },
    { hostname: "other.example.com", service: "http://127.0.0.1:30141" },
  ];
  const result = classifyDomainBinding(routes, CUSTOM, PORT);
  assert.equal(result.state, "bound");
  assert.equal(result.reason, null);
  assert.equal(result.origin, CUSTOM, "自定义域名被覆盖时 origin 用 preferred");
});

test("classifyDomainBinding：通配 / catch-all 覆盖自定义域名 → bound", () => {
  assert.equal(
    classifyDomainBinding([{ hostname: "*.example.com", service: "http://127.0.0.1:30141" }], CUSTOM, PORT).state,
    "bound",
  );
  assert.equal(
    classifyDomainBinding([{ service: "http://127.0.0.1:30141" }], CUSTOM, PORT).state,
    "bound",
  );
});

test("classifyDomainBinding：只推送别的域名 → unbound(other-hostnames)", () => {
  const routes = [{ hostname: "other.example.com", service: "http://127.0.0.1:30141" }];
  const result = classifyDomainBinding(routes, CUSTOM, PORT);
  assert.equal(result.state, "unbound");
  assert.equal(result.reason, "other-hostnames");
});

test("classifyDomainBinding：空规则表同样算未绑定", () => {
  const result = classifyDomainBinding([], CUSTOM, PORT);
  assert.equal(result.state, "unbound");
  assert.equal(result.reason, "other-hostnames");
});

test("classifyDomainBinding：域名在路由里但指向别处 → unbound(service-mismatch)", () => {
  const routes = [{ hostname: "pi.example.com", service: "http://127.0.0.1:9999" }];
  const result = classifyDomainBinding(routes, CUSTOM, PORT);
  assert.equal(result.state, "unbound");
  assert.equal(result.reason, "service-mismatch");
});

test("classifyDomainBinding：端口不符的网关路由不算 bound", () => {
  const routes = [{ hostname: "*.example.com", service: "http://127.0.0.1:30000" }];
  const result = classifyDomainBinding(routes, CUSTOM, PORT);
  assert.equal(result.state, "unbound");
  assert.equal(result.reason, "service-mismatch");
});
