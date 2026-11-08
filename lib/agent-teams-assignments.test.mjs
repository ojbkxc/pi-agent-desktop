import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const {
  dispatchAssignment,
  AssignmentConflictError,
  AssignmentNotFoundError,
  isValidTicketId,
} = await jiti.import("@/lib/agent-teams-assignments.ts");

let teamDir;
test.before(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "pi-teams-assign-"));
});
test.after(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

function writeTicket(id, body) {
  return writeFile(join(teamDir, "tickets", `${id}.json`), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

async function readTicket(id) {
  return JSON.parse(await readFile(join(teamDir, "tickets", `${id}.json`), "utf8"));
}

async function readSidecar(id) {
  return JSON.parse(await readFile(join(teamDir, "tickets", `${id}.dispatch.json`), "utf8"));
}

function makeDeps(overrides = {}) {
  return {
    teamDir,
    rawTeamName: "demo",
    memberNames: ["alice", "bob", "carol"],
    now: () => Date.now(),
    uuid: () => Math.random().toString(36).slice(2, 10),
    send: async () => ({ outcome: "woken" }),
    wake: async () => true,
    ...overrides,
  };
}

async function seedTicket(id, assignments = []) {
  await mkdir(join(teamDir, "tickets"), { recursive: true });
  await writeTicket(id, {
    schemaVersion: 1,
    id,
    teamName: "demo",
    subject: `工单 ${id}`,
    status: "open",
    createdBy: "team-lead",
    createdAt: 1,
    updatedAt: 1,
    assignments,
  });
}

const SENT = [];

test.beforeEach(() => {
  SENT.length = 0;
});

test("首次分配：写归属 + sidecar + 投递（删掉 send 必红的判别载体）", async () => {
  await seedTicket("t1", []);
  const deps = makeDeps({
    send: async (to, body) => {
      SENT.push({ to, body });
      return { outcome: "injected" };
    },
  });
  const result = await dispatchAssignment(deps, { action: "assign", clientRequestId: "req-1", ticketId: "t1", toMember: "alice" });
  assert.equal(result.ok, true);
  assert.equal(result.assignment.assignee, "alice");
  assert.deepEqual(SENT.map((item) => item.to), ["alice"], "投递必须发生");
  assert.match(SENT[0].body, /Pi Web 人工调度/);
  const ticket = await readTicket("t1");
  assert.equal(ticket.assignments[0].status, "pending");
  const sidecar = await readSidecar("t1");
  assert.equal(sidecar.records[0].clientRequestId, "req-1");
  assert.equal(sidecar.records[0].outcome, "injected");
});

test("同 clientRequestId 精确指纹重试：不新建、不重发（skipped）", async () => {
  await seedTicket("t2", []);
  const deps = makeDeps({
    send: async (to) => {
      SENT.push({ to });
      return { outcome: "woken" };
    },
  });
  await dispatchAssignment(deps, { action: "assign", clientRequestId: "req-2", ticketId: "t2", toMember: "bob", note: "加油" });
  SENT.length = 0;
  const retry = await dispatchAssignment(deps, { action: "assign", clientRequestId: "req-2", ticketId: "t2", toMember: "bob", note: "加油" });
  assert.deepEqual(SENT, [], "已交付的重试不得重新 send（防邮箱重复文本）");
  assert.deepEqual(retry.delivery, { to: "bob", skipped: "already-delivered" });
  const ticket = await readTicket("t2");
  assert.equal(ticket.assignments.length, 1, "不重复新建 assignment");
});

test("同 clientRequestId 改参数 ⇒ 409；failed 重试 ⇒ 重发；多记录并存", async () => {
  await seedTicket("t3", []);
  const deps = makeDeps({
    send: async (to) => {
      SENT.push({ to });
      return { outcome: "failed", error: "背压" };
    },
  });
  await dispatchAssignment(deps, { action: "assign", clientRequestId: "req-3", ticketId: "t3", toMember: "alice" });
  await assert.rejects(
    dispatchAssignment(deps, { action: "assign", clientRequestId: "req-3", ticketId: "t3", toMember: "bob" }),
    (error) => error instanceof AssignmentConflictError && /参数不同/.test(error.message),
  );
  // failed 重试：重发（writeToMailbox 失败未落盘，无重复风险）。
  SENT.length = 0;
  const deps2 = makeDeps({
    send: async (to) => {
      SENT.push({ to });
      return { outcome: "injected" };
    },
  });
  const retried = await dispatchAssignment(deps2, { action: "assign", clientRequestId: "req-3", ticketId: "t3", toMember: "alice" });
  assert.deepEqual(SENT.map((item) => item.to), ["alice"]);
  assert.equal(retried.delivery.outcome, "injected");

  // 多记录：同票第二次调度（另一个 clientRequestId），旧记录不被擦。
  const deps3 = makeDeps({ send: async () => ({ outcome: "woken" }) });
  // 先把票里既有 assignment 结束语义交给 reassign 场景测试；这里走第二张票验证多记录。
  await seedTicket("t3b", []);
  await dispatchAssignment(deps3, { action: "assign", clientRequestId: "req-3b", ticketId: "t3b", toMember: "carol" });
  const sidecar = await readSidecar("t3b");
  assert.equal(sidecar.records.length, 1);
});

test("改派：旧 pending ⇒ ended+cancelled、新 pending、投递给新人；running ⇒ 409", async () => {
  await seedTicket("t4", [
    { id: "assign-old", assignee: "bob", status: "pending", createdAt: 1, updatedAt: 42 },
  ]);
  const deps = makeDeps({
    send: async (to) => {
      SENT.push({ to });
      return { outcome: "woken" };
    },
  });
  const result = await dispatchAssignment(deps, {
    action: "reassign", clientRequestId: "req-4", ticketId: "t4", assignmentId: "assign-old", toMember: "carol", expectedUpdatedAt: 42, note: "换人",
  });
  assert.equal(result.assignment.assignee, "carol");
  assert.deepEqual(SENT.map((item) => item.to), ["carol"]);
  const ticket = await readTicket("t4");
  const oldOne = ticket.assignments.find((item) => item.id === "assign-old");
  const newOne = ticket.assignments.find((item) => item.id === result.assignment.id);
  assert.equal(oldOne.status, "ended");
  assert.equal(oldOne.outcome, "cancelled");
  assert.equal(newOne.status, "pending");

  // running ⇒ 409（双主）。
  await seedTicket("t5", [{ id: "assign-run", assignee: "bob", status: "running", createdAt: 1, updatedAt: 7 }]);
  await assert.rejects(
    dispatchAssignment(deps, { action: "reassign", clientRequestId: "req-5", ticketId: "t5", assignmentId: "assign-run", toMember: "carol", expectedUpdatedAt: 7 }),
    (error) => error instanceof AssignmentConflictError && /双主/.test(error.message),
  );
});

test("expectedUpdatedAt 代际不符 ⇒ 409；首次分配遇活跃派活 ⇒ 409；toMember 不在名册 ⇒ 404", async () => {
  await seedTicket("t6", [{ id: "a1", assignee: "bob", status: "pending", createdAt: 1, updatedAt: 42 }]);
  const deps = makeDeps();
  await assert.rejects(
    dispatchAssignment(deps, { action: "reassign", clientRequestId: "req-6", ticketId: "t6", assignmentId: "a1", toMember: "carol", expectedUpdatedAt: 41 }),
    (error) => error instanceof AssignmentConflictError && /代际不匹配/.test(error.message),
  );
  await assert.rejects(
    dispatchAssignment(deps, { action: "assign", clientRequestId: "req-7", ticketId: "t6", toMember: "carol" }),
    (error) => error instanceof AssignmentConflictError && /未结束的派活/.test(error.message),
  );
  await assert.rejects(
    dispatchAssignment(deps, { action: "assign", clientRequestId: "req-8", ticketId: "t6", toMember: "ghost" }),
    (error) => error instanceof AssignmentNotFoundError && /不在团队名册/.test(error.message),
  );
});

test("票属团队核对：teamName 不符 ⇒ 409；ticketId 非法 ⇒ false", async () => {
  await mkdir(join(teamDir, "tickets"), { recursive: true });
  await writeTicket("t-other", { id: "t-other", teamName: "elsewhere", subject: "别的团队", status: "open", assignments: [] });
  const deps = makeDeps();
  await assert.rejects(
    dispatchAssignment(deps, { action: "assign", clientRequestId: "req-9", ticketId: "t-other", toMember: "alice" }),
    (error) => error instanceof AssignmentConflictError && /不属于团队/.test(error.message),
  );
  assert.equal(isValidTicketId("../escape"), false);
  assert.equal(isValidTicketId("ok-ticket.1"), true);
});

test("多记录幂等：同票 assign A → reassign B → 重试 A ⇒ 复用 A 原 assignment、0 send、不碰 B", async () => {
  await seedTicket("t-multi", []);
  const deps = makeDeps({
    send: async (to) => {
      SENT.push({ to });
      return { outcome: "woken" };
    },
  });
  await dispatchAssignment(deps, { action: "assign", clientRequestId: "mA", ticketId: "t-multi", toMember: "alice" });
  // 改派给 bob（结束 alice 的 assignment）。
  const ticket1 = await readTicket("t-multi");
  const aId = ticket1.assignments.find((item) => item.assignee === "alice").id;
  await dispatchAssignment(deps, {
    action: "reassign", clientRequestId: "mB", ticketId: "t-multi", assignmentId: aId, toMember: "bob", expectedUpdatedAt: ticket1.assignments.find((item) => item.assignee === "alice").updatedAt,
  });
  const sendCountBefore = SENT.length;
  // 重试 A（旧 clientRequestId）：必须复用 A 原 assignment、不重新 send、不新建。
  const retry = await dispatchAssignment(deps, { action: "assign", clientRequestId: "mA", ticketId: "t-multi", toMember: "alice" });
  assert.deepEqual(SENT.slice(sendCountBefore), [], "旧请求重试不得重新 send");
  assert.equal(retry.assignment.assignee, "alice", "复用 A 原 assignment");
  const ticket2 = await readTicket("t-multi");
  assert.equal(ticket2.assignments.filter((item) => item.assignee === "alice").length, 1, "不新建 A 的 assignment");
  assert.equal(ticket2.assignments.filter((item) => item.assignee === "bob").length, 1, "B 不受影响");
  const sidecar = await readSidecar("t-multi");
  assert.equal(sidecar.records.length, 2, "两条调度记录并存");
});

test("send 抛错：delivery=failed + warnings + sidecar 停 pending-send，同 ID 可恢复", async () => {
  await seedTicket("t-throw", []);
  const deps = makeDeps({
    send: async () => {
      throw new Error("bus exploded");
    },
  });
  const result = await dispatchAssignment(deps, { action: "assign", clientRequestId: "t-throw-1", ticketId: "t-throw", toMember: "alice" });
  assert.equal(result.delivery.outcome, "failed");
  assert.ok(result.warnings.some((warning) => /投递结果未知/.test(warning)), "必须如实告知结果未知，不谎报 exactly-once");
  const sidecar = await readSidecar("t-throw");
  assert.equal(sidecar.records[0].outcome, "pending-send");
  // 同 ID 重试恢复：成功投递。
  const deps2 = makeDeps({
    send: async () => ({ outcome: "injected" }),
  });
  const recovered = await dispatchAssignment(deps2, { action: "assign", clientRequestId: "t-throw-1", ticketId: "t-throw", toMember: "alice" });
  assert.equal(recovered.delivery.outcome, "injected");
  const ticket = await readTicket("t-throw");
  assert.equal(ticket.assignments.filter((item) => item.assignee === "alice").length, 1, "恢复不新建");
});

test("roster null ⇒ 中止派发；roster 新鲜 sessionId 唤新会话（未命中不回退旧值）", async () => {
  await seedTicket("t-fresh", []);
  // roster 注入且返回 null ⇒ 中止（不回退 memberNames 快照）。
  const depsNull = makeDeps({
    roster: async () => null,
  });
  await assert.rejects(
    dispatchAssignment(depsNull, { action: "assign", clientRequestId: "r-null", ticketId: "t-fresh", toMember: "alice" }),
    (error) => error instanceof AssignmentNotFoundError && /名册已不可读/.test(error.message),
  );
  const untouched = await readTicket("t-fresh");
  assert.equal(untouched.assignments.length, 0, "中止不得写票");

  // 队列等待后换 sessionId：roster 返回新 sessionId ⇒ wake 唤新会话；rosterMembers
  // 未命中（成员被删）⇒ 完全不 wake（不回退旧值）。
  await seedTicket("t-fresh2", []);
  const wakeTargets = [];
  const depsFresh = makeDeps({
    send: async () => ({ outcome: "revived" }),
    wake: async (sessionId) => {
      wakeTargets.push(sessionId);
      return true;
    },
    memberSessionId: () => "stale-session",
    roster: async () => ({
      names: ["alice", "bob"],
      members: [{ name: "alice", sessionId: "fresh-session" }],
    }),
  });
  const fresh = await dispatchAssignment(depsFresh, { action: "assign", clientRequestId: "r-fresh", ticketId: "t-fresh2", toMember: "alice" });
  assert.equal(fresh.delivery.outcome, "revived");
  assert.deepEqual(wakeTargets, ["fresh-session"], "唤醒用票锁内新 sessionId");

  // 成员被删（rosterMembers 未命中 toMember）⇒ 不回退旧 sessionId、不 wake。
  await seedTicket("t-fresh3", []);
  const depsGone = makeDeps({
    send: async () => ({ outcome: "revived" }),
    wake: async (sessionId) => {
      wakeTargets.push(sessionId);
      return true;
    },
    memberSessionId: () => "stale-session",
    roster: async () => ({
      names: ["bob"],
      members: [{ name: "bob", sessionId: "sess-bob" }],
    }),
  });
  await assert.rejects(
    dispatchAssignment(depsGone, { action: "assign", clientRequestId: "r-gone", ticketId: "t-fresh3", toMember: "alice" }),
    (error) => error instanceof AssignmentNotFoundError && /不在团队名册/.test(error.message),
  );
});

test("返工第15项：不存在票 ⇒ 404 且 tickets 目录零残留（无 {} 占位文件）", async () => {
  const deps = makeDeps();
  await assert.rejects(
    dispatchAssignment(deps, { action: "assign", clientRequestId: "r-nope", ticketId: "t-nope", toMember: "alice" }),
    (error) => error instanceof AssignmentNotFoundError && /不存在/.test(error.message),
  );
  // 零残留：tickets 目录里不得出现 t-nope.json 或 t-nope.dispatch.json（.lock 由
  // proper-lockfile 清理；即便瞬时残留锁目录也不算票据残留——只断言 json/sidecar）。
  const { readdir } = await import("node:fs/promises");
  const names = (await readdir(join(teamDir, "tickets"))).filter((name) => name.startsWith("t-nope"));
  assert.deepEqual(names, [], `不得残留 t-nope 任何文件，实际: ${JSON.stringify(names)}`);
  // 同样不产生可被后续请求误读的空票。
  const deps2 = makeDeps();
  await assert.rejects(
    dispatchAssignment(deps2, { action: "assign", clientRequestId: "r-nope-2", ticketId: "t-nope", toMember: "alice" }),
    (error) => error instanceof AssignmentNotFoundError,
    "第二次请求仍须 404，不得因残留文件变 409",
  );
});

test("返工第15项回归：正常票加锁/派发/幂等/改派不回归", async () => {
  await seedTicket("t-lock", []);
  const deps = makeDeps({
    send: async (to) => {
      SENT.push({ to });
      return { outcome: "injected" };
    },
  });
  const result = await dispatchAssignment(deps, { action: "assign", clientRequestId: "r-lock", ticketId: "t-lock", toMember: "alice" });
  assert.equal(result.ok, true);
  assert.equal(result.delivery.outcome, "injected");
  await dispatchAssignment(deps, { action: "assign", clientRequestId: "r-lock", ticketId: "t-lock", toMember: "alice" });
  const ticket = await readTicket("t-lock");
  assert.equal(ticket.assignments.length, 1, "幂等不重复新建");
});
