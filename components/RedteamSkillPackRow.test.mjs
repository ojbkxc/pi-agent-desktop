import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8").then((s) => s.replace(/\r\n/g, "\n"));

test("SkillsConfig 在技能列表上方渲染红队技能包入口", async () => {
  const source = await read("./SkillsConfig.tsx");
  assert.match(source, /import \{ RedteamSkillPackRow \} from "\.\/RedteamSkillPackRow"/);
  const mount = source.indexOf("<RedteamSkillPackRow");
  assert.ok(mount > 0, "未挂载技能包入口");
  assert.ok(
    source.indexOf("<ConfigSplitView>") > mount,
    "入口应位于列表/详情分栏之前（不是藏在某个技能的详情里）",
  );
});

test("RedteamSkillPackRow：读状态、装/卸各传对应 action、常驻边界文案", async () => {
  const source = await read("./RedteamSkillPackRow.tsx");
  assert.match(source, /fetch\("\/api\/skills\/redteam"\)/);
  assert.match(source, /body: JSON\.stringify\(\{ action \}\)/);
  assert.match(source, /act\(installed \? "uninstall" : "install"\)/);
  // 边界必须常驻，不是一次性 toast。
  assert.match(source, /t\("skills\.redteamPack\.notice"\)/);
  // 打包里没有这个包时不渲染死按钮。
  assert.match(source, /if \(!status\?\.bundled\) return null/);
});
