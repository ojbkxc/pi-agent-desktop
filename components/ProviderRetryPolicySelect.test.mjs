import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * `ProviderRetryPolicySelect` 的源级契约（与仓库既有组件测试同一手法：这类文件
 * 在测试里没有 React 运行时，行为面由 `lib/outage/retry-policy-hook.test.mjs`
 * 端到端钉住，这里守的是「界面不许骗人」那几条）。
 */
const source = await readFile(new URL("./ProviderRetryPolicySelect.tsx", import.meta.url), "utf8");
const modelsConfig = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");

test("the control uses the shared app selector and reads/writes its own endpoint", () => {
  // 仓库的菜单一致性守卫禁止原生 <select>：应用内的选择器必须走 AppSelect。
  assert.match(source, /import \{ AppSelect \} from "@\/components\/AppSelect"/);
  assert.doesNotMatch(source, /<select[\s>]/, "a native <select> is forbidden by the app-menu guard");
  assert.match(source, /fetch\(`\/api\/model-retry-policy\?provider=\$\{encodeURIComponent\(providerId\)\}`\)/, "reads per provider");
  assert.match(source, /method: "PUT"/, "saves with PUT");
  assert.match(source, /body: JSON\.stringify\(\{ provider: providerId, policy: value \}\)/, "the body names the provider and the policy");
});

test("a failed save rolls the control back instead of showing an unsaved choice", () => {
  // 保存失败必须回到旧值：界面上显示一个没落盘的策略，等于告诉用户「已经开了」。
  const change = source.slice(source.indexOf("const change = useCallback"), source.indexOf("const options"));
  assert.match(change, /const previous = policy;/, "the old value is captured before the write");
  assert.match(change, /catch \{\s*setPolicy\(previous\);/, "and restored on failure");
  assert.match(change, /models\.retryPolicySaveFailed/, "with a visible reason");
});

test("a read failure falls back to `default`, never blocks the panel", () => {
  const effect = source.slice(source.indexOf("useEffect("), source.indexOf("const change = useCallback"));
  assert.match(effect, /\.catch\(\(\) => \{/, "the read has a failure path");
  assert.match(effect, /setPolicy\("default"\)/, "which shows the default policy");
  assert.match(effect, /setLoaded\(true\)/, "and still enables the control");
  assert.match(effect, /return \(\) => \{\s*cancelled = true;/, "a late response from another provider must not land");
});

test("the three policies are the ones the backend accepts", () => {
  for (const policy of ["default", "transient", "all"]) {
    assert.ok(source.includes(`value: "${policy}"`), `${policy} must be selectable`);
  }
  assert.match(source, /models\.retryPolicyAllHint/, "the `all` choice explains what it does");
});

test("the control is mounted in the provider editor, next to the API field", () => {
  const apiField = modelsConfig.indexOf('t("models.fieldApi")');
  const mount = modelsConfig.indexOf("<ProviderRetryPolicySelect providerId={name} />");
  const headersField = modelsConfig.indexOf('t("models.fieldHeaders")');
  assert.ok(mount > 0, "the provider editor renders the control");
  assert.ok(apiField > 0 && mount > apiField, "it sits after the API field");
  assert.ok(headersField > mount, "and before the headers editor");
});