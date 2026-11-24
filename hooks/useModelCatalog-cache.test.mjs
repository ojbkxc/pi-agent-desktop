import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

/**
 * 模型目录缓存（审批弹框「点几次才好」的根因修复）。
 *
 * 现象：打开「Review configuration」后**立刻**点成员的模型下拉 —— 完全没反应，等一两秒
 * 再点才有用。根因是 `useModelCatalog` 的 `loading` 初值恒为 `true`，而
 * `PlanEditor` 的模型下拉是 `disabled={!editable || catalog.loading}`；`AppSelect` 把
 * `disabled` 传给原生 `<button disabled>`，浏览器根本不派发 click，第一下就被吞掉。
 * 重开弹框会卸载再挂载、`loading` 复位，所以同一个窗口反复出现。
 *
 * 修法：按 cwd 键控的模块级缓存。**第二次及以后的挂载**直接以 `loading=false` 起渲染，
 * 下拉立即可点；首次挂载与 `refresh()` 的语义不变。
 */
const jiti = createJiti(import.meta.url, {
  alias: { react: fileURLToPath(new URL("./__fixtures__/fake-react.mjs", import.meta.url)) },
});
const ReactFake = await jiti.import("react");
const { useModelCatalog } = await jiti.import("./useModelCatalog.ts");

const MODELS = { models: { "openai/gpt-5": "GPT-5" }, modelList: [{ id: "gpt-5", name: "GPT-5", provider: "openai" }] };
const ENABLED = { allEnabled: false, providers: [{ id: "openai", models: [{ ref: "openai/gpt-5", enabled: true }] }] };

function mkResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

/** 装 fetch 桩；返回一个可以「结算」的把手。 */
function stubFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => mkResponse(String(url).includes("/enabled") ? ENABLED : MODELS);
  return () => { globalThis.fetch = original; };
}

/** 与 useTeamPlan.test.mjs 同一套 mount 夹具：effect 由测试显式 flush。 */
function mount(cwd) {
  let latest;
  const cleanups = [];
  const render = () => {
    ReactFake.__beginRender();
    latest = useModelCatalog(cwd);
  };
  ReactFake.__setNotify(render);
  ReactFake.__reset();
  render();
  return {
    get current() { return latest; },
    flush: () => { for (const cleanup of ReactFake.__flushEffects()) cleanups.push(cleanup); },
    unmount: () => { for (const cleanup of cleanups.splice(0)) cleanup(); },
  };
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a cold mount still starts loading, then settles with the catalog", async (t) => {
  t.after(stubFetch());
  const first = mount("/repo/cold-start");
  first.flush();
  assert.equal(first.current.loading, true, "nothing cached yet: keep the spinner");
  await settle();
  assert.equal(first.current.loading, false, "settles once /api/models answers");
  assert.equal(first.current.catalog.entries.length > 0, true, "and the catalog is real");
  first.unmount();
});

test("a remount for the same cwd starts ready: the first click is not swallowed", async (t) => {
  t.after(stubFetch());
  const cwd = "/repo/warm-start";
  const first = mount(cwd);
  first.flush();
  await settle();
  const loaded = first.current.catalog;
  first.unmount();

  // 重开弹框 = 卸载再挂载。缓存命中 ⇒ loading 初值 false，模型下拉立即可点。
  const second = mount(cwd);
  second.flush();
  assert.equal(second.current.loading, false, "the remount must not re-enter the loading window");
  assert.deepEqual(second.current.catalog, loaded, "…and it renders the cached catalog, not an empty one");
  second.unmount();
});

test("a different cwd does not reuse the cache", async (t) => {
  t.after(stubFetch());
  const first = mount("/repo/project-a");
  first.flush();
  await settle();
  first.unmount();

  const other = mount("/repo/project-b");
  other.flush();
  assert.equal(other.current.loading, true, "another project loads its own catalog");
  await settle();
  other.unmount();
});
