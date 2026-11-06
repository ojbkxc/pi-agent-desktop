import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const port = await import("./server-port.ts");

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "pi-server-port-"));
  const path = join(dir, "pi-web", "settings.json");
  mkdirSync(join(dir, "pi-web"), { recursive: true });
  return { dir, path };
}

test("未配置 / 非法值 / 坏文件都回退到 null", () => {
  const { dir, path } = temp();
  try {
    assert.equal(port.readConfiguredServerPort(process.env, path), null, "文件不存在");
    writeFileSync(path, JSON.stringify({ serverPort: 80 }), { flag: "w" });
    assert.equal(port.readConfiguredServerPort(process.env, path), null, "端口越界");
    writeFileSync(path, "{not json");
    assert.equal(port.readConfiguredServerPort(process.env, path), null, "坏文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("读写端口，保留其它键", () => {
  const { dir, path } = temp();
  try {
    port.writeConfiguredServerPort(41234, path);
    assert.equal(port.readConfiguredServerPort(process.env, path), 41234);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, serverPort: 41234 });
    assert.throws(() => port.writeConfiguredServerPort(80, path), /1024 to 65535/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
