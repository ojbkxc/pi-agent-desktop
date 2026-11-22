import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 团队运行时控件客户端 store：scope 分桶、暂停请求→确认、resume 互斥与失败、
 * 换代（incarnation 不符）拒收。fetch 换桩，不触真实网络。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const {
  teamRuntimeControl,
  teamRuntimeControlEntryForTest,
  resetTeamRuntimeControlForTest,
  teamRuntimeScope,
  teamRuntimeControlKey,
  PAUSE_CONFIRM_TIMEOUT_MS,
} = await jiti.import("@/hooks/useTeamRuntimeControlStore.ts");

const SCOPE = { teamName: "demo", leadSessionId: "sess-lead", incarnationId: "inc-1" };
const VIEW = (over = {}) => ({
  schemaVersion: 1,
  teamName: "demo",
  leadSessionId: "sess-lead",
  incarnationId: "inc-1",
  revision: 1,
  epoch: 0,
  status: "running",
  updatedAt: 0,
  members: [],
  resumeEligibleCount: 0,
  ...over,
});

const entry = () => teamRuntimeControlEntryForTest(SCOPE);

/** fetch 桩：按「METHOD url」路由到假响应。 */
function stubFetch(routes) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const handler = routes(`${init?.method ?? "GET"} ${url}`);
    if (!handler) throw new Error(`no stub for ${init?.method ?? "GET"} ${url}`);
    return handler();
  };
  return { restore: () => { globalThis.fetch = previous; } };
}

test.beforeEach(() => {
  resetTeamRuntimeControlForTest();
});

test("scope 与 key：未定字段 ⇒ null；key 稳定", () => {
  assert.equal(teamRuntimeScope(null), null);
  assert.equal(teamRuntimeScope({ name: "demo" }), null, "缺 leadSessionId/incarnationId 不构成 scope");
  const scope = teamRuntimeScope({ name: "demo", leadSessionId: "s", incarnationId: "i" });
  assert.deepEqual(scope, { teamName: "demo", leadSessionId: "s", incarnationId: "i" });
  assert.equal(teamRuntimeControlKey(scope), JSON.stringify(["demo", "s", "i"]));
  assert.equal(typeof PAUSE_CONFIRM_TIMEOUT_MS, "number");
  assert.ok(PAUSE_CONFIRM_TIMEOUT_MS > 0, "暂停确认超时是常量（15s，cc-haha 同款）");
});

test("refresh：拉取视图入桶；404 清空；错误留 error", async () => {
  const stub = stubFetch((route) => {
    if (route === "GET /api/teams/demo/runtime-control") {
      return () => Promise.resolve(new Response(JSON.stringify(VIEW()), { status: 200 }));
    }
    return null;
  });
  try {
    const view = await teamRuntimeControl.refresh(SCOPE);
    assert.equal(view.status, "running");
    assert.equal(entry().view.revision, 1);
    assert.equal(entry().loading, false);
    assert.equal(entry().error, null);
  } finally {
    stub.restore();
  }

  const stub404 = stubFetch(() => () => Promise.resolve(new Response("{}", { status: 404 })));
  try {
    await teamRuntimeControl.refresh(SCOPE);
    assert.equal(entry().view, null, "404 清空视图");
  } finally {
    stub404.restore();
  }

  const stub500 = stubFetch(() => () => Promise.resolve(new Response("{}", { status: 500 })));
  try {
    await teamRuntimeControl.refresh(SCOPE);
    assert.match(entry().error, /HTTP 500/);
  } finally {
    stub500.restore();
  }
});

test("pause 流：markPauseRequested ⇒ pauseRequested；refresh 确认（status 非 running）⇒ 复位", async () => {
  const stub = stubFetch((route) => {
    if (route === "GET /api/teams/demo/runtime-control") {
      return () => Promise.resolve(new Response(JSON.stringify(VIEW()), { status: 200 }));
    }
    return null;
  });
  try {
    await teamRuntimeControl.refresh(SCOPE);
    assert.equal(entry().pauseRequested, false);

    teamRuntimeControl.markPauseRequested(SCOPE);
    assert.equal(entry().pauseRequested, true, "客户端立即进入请求暂停态");

    // 服务端确认（paused, revision 前进）⇒ pauseRequested 复位
    const stubPaused = stubFetch(() => () => Promise.resolve(new Response(JSON.stringify(
      VIEW({ status: "paused", revision: 2, epoch: 1 }),
    ), { status: 200 })));
    try {
      await teamRuntimeControl.refresh(SCOPE);
      assert.equal(entry().pauseRequested, false);
      assert.equal(entry().view.status, "paused");
    } finally {
      stubPaused.restore();
    }
  } finally {
    stub.restore();
  }
});

test("pause 后 revision 未前进的 running 响应不确认（防旧轮询复位请求态）", async () => {
  const stub = stubFetch((route) => {
    if (route === "GET /api/teams/demo/runtime-control") {
      return () => Promise.resolve(new Response(JSON.stringify(VIEW({ revision: 1 })), { status: 200 }));
    }
    return null;
  });
  try {
    await teamRuntimeControl.refresh(SCOPE);
    teamRuntimeControl.markPauseRequested(SCOPE);
    // 旧轮询的 running 响应（revision 没越过发起点）不该复位 pauseRequested。
    await teamRuntimeControl.refresh(SCOPE);
    assert.equal(entry().pauseRequested, true, "未确认前保持请求态");
  } finally {
    stub.restore();
  }
});

test("resume：paused ⇒ POST resume ⇒ running；running 状态拒绝发起", async () => {
  const stub = stubFetch((route) => {
    if (route === "GET /api/teams/demo/runtime-control") {
      return () => Promise.resolve(new Response(JSON.stringify(VIEW({ status: "paused", revision: 2 })), { status: 200 }));
    }
    if (route === "POST /api/teams/demo/runtime-control") {
      return () => Promise.resolve(new Response(JSON.stringify(
        VIEW({ status: "running", revision: 3, epoch: 1 }),
      ), { status: 200 }));
    }
    return null;
  });
  try {
    await teamRuntimeControl.refresh(SCOPE);
    assert.equal(entry().view.status, "paused");

    const view = await teamRuntimeControl.resume(SCOPE);
    assert.equal(view.status, "running");
    assert.equal(entry().view.revision, 3);
    assert.equal(entry().busy, false, "完成后 busy 复位");
    assert.equal(entry().operation, null);

    await assert.rejects(() => teamRuntimeControl.resume(SCOPE), /状态已变化/, "running 状态不能 resume");
  } finally {
    stub.restore();
  }
});

test("resume：服务端 409 ⇒ error 留痕 + busy 复位", async () => {
  const stub = stubFetch((route) => {
    if (route === "GET /api/teams/demo/runtime-control") {
      return () => Promise.resolve(new Response(JSON.stringify(VIEW({ status: "partial", revision: 2 })), { status: 200 }));
    }
    if (route === "POST /api/teams/demo/runtime-control") {
      return () => Promise.resolve(new Response(JSON.stringify({ error: "团队身份已变化" }), { status: 409 }));
    }
    return null;
  });
  try {
    await teamRuntimeControl.refresh(SCOPE);
    await assert.rejects(() => teamRuntimeControl.resume(SCOPE), /身份已变化/);
    assert.equal(entry().busy, false);
    assert.match(entry().error, /身份已变化/);
  } finally {
    stub.restore();
  }
});

test("换代拒收：incarnationId 不符的响应不入桶并留 error", async () => {
  const stub = stubFetch(() => () => Promise.resolve(new Response(JSON.stringify(
    VIEW({ incarnationId: "inc-NEW", revision: 9 }),
  ), { status: 200 })));
  try {
    const view = await teamRuntimeControl.refresh(SCOPE);
    assert.equal(view, null, "换代响应被拒");
    assert.match(entry().error, /身份已变化/);
  } finally {
    stub.restore();
  }
});

test("pause：POST action=pause（带 leadSessionId/incarnationId），成功后入桶并复位请求态", async () => {
  const previous = globalThis.fetch;
  let posted = null;
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return new Response(JSON.stringify(VIEW()), { status: 200 });
    posted = JSON.parse(init.body);
    return new Response(JSON.stringify(VIEW({ status: "paused", revision: 2, epoch: 1 })), { status: 200 });
  };
  try {
    await teamRuntimeControl.refresh(SCOPE);
    teamRuntimeControl.markPauseRequested(SCOPE);
    assert.equal(entry().pauseRequested, true);

    const view = await teamRuntimeControl.pause(SCOPE);
    assert.equal(posted.action, "pause", "必须真正 POST 服务端 pause");
    assert.equal(posted.leadSessionId, "sess-lead");
    assert.equal(posted.incarnationId, "inc-1");
    assert.equal(view.status, "paused");
    assert.equal(entry().view.status, "paused");
    assert.equal(entry().pauseRequested, false, "确认后复位请求态");
    assert.equal(entry().busy, false);
  } finally {
    globalThis.fetch = previous;
  }
});

test("pause：服务端失败留 error 并复位请求态（不卡在 pausing）", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return new Response(JSON.stringify(VIEW()), { status: 200 });
    return new Response(JSON.stringify({ error: "host.stop 爆了" }), { status: 500 });
  };
  try {
    await teamRuntimeControl.refresh(SCOPE);
    teamRuntimeControl.markPauseRequested(SCOPE);
    await assert.rejects(() => teamRuntimeControl.pause(SCOPE), /host\.stop 爆了/);
    assert.match(entry().error, /host\.stop 爆了/);
    assert.equal(entry().pauseRequested, false, "失败后不留在请求态");
    assert.equal(entry().busy, false);
  } finally {
    globalThis.fetch = previous;
  }
});
