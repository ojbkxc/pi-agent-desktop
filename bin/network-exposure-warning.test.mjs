import assert from "node:assert/strict";
import test from "node:test";
import { checkNetworkExposure } from "./network-exposure-warning.js";

// d2-3: pins the LAN exposure semantics instead of changing them. A listener
// beyond loopback with no password hands a shell (the terminal API, agent
// sessions) to anyone on the network, so the launcher refuses to start unless
// the operator says so explicitly with PI_WEB_ALLOW_UNAUTHENTICATED=1 — and
// even then it warns. The dev:lan/start:lan path is the deliberate exception.

test("loopback listeners get no exposure warning", () => {
  for (const hostname of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
    assert.equal(checkNetworkExposure(hostname, {}), null);
    assert.equal(
      checkNetworkExposure(hostname, { PI_WEB_PASSWORD: "pw", PI_WEB_ALLOW_UNAUTHENTICATED: "1" }),
      null,
    );
  }
});

test("a password-protected LAN listener warns about cleartext transit", () => {
  const exposure = checkNetworkExposure("0.0.0.0", { PI_WEB_PASSWORD: "pw" });
  assert.equal(exposure?.fatal, false);
  assert.match(exposure?.message ?? "", /password authentication over HTTP/);
});

test("an unauthenticated LAN listener must not start without the explicit opt-in", () => {
  const exposure = checkNetworkExposure("0.0.0.0", {});
  assert.equal(exposure?.fatal, true);
  assert.match(exposure?.message ?? "", /Refusing to listen/);

  // A value other than "1" does not count as the operator's choice.
  assert.equal(checkNetworkExposure("0.0.0.0", { PI_WEB_ALLOW_UNAUTHENTICATED: "true" })?.fatal, true);
  assert.equal(checkNetworkExposure("0.0.0.0", { PI_WEB_ALLOW_UNAUTHENTICATED: "" })?.fatal, true);
});

test("the explicit opt-in keeps the unauthenticated warning", () => {
  const exposure = checkNetworkExposure("192.168.1.10", { PI_WEB_ALLOW_UNAUTHENTICATED: "1" });
  assert.equal(exposure?.fatal, false);
  assert.match(exposure?.message ?? "", /can run shell commands and read files as you/);
  assert.match(exposure?.message ?? "", /PI_WEB_PASSWORD/);
});
