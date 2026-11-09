/**
 * 极简 React hooks 替身（仅供 hooks/useTeamPlan.test.mjs 在无 DOM 的 Node 里驱动 hook）。
 *
 * 仓库没有 jsdom / react-test-renderer，数据型 hook 无处可跑。这里只实现 useTeamPlan 用到的
 * useCallback / useEffect / useRef / useState 的**最小语义**：
 * - hook 槽位跨渲染持久化（同一位置 index 复用）；
 * - useEffect 只在首渲染或 deps 变化时入队，由测试显式 `__flushEffects()` 执行；
 * - setState 调 `__notify`，harness 借它同步触发一次重渲染，让断言读到更新后的返回值。
 *
 * 这不是通用 React，别拿去测别的组件。
 */
let cursor = 0;
let slots = [];
let pending = [];
let notify = () => {};

/** 清空槽位（每次 mount 前调用）。 */
export function __reset() {
  cursor = 0;
  slots = [];
  pending = [];
}

/** harness 注册「状态变化 → 重渲染」回调。 */
export function __setNotify(fn) {
  notify = fn;
}

/** 每次渲染开头归零指针。 */
export function __beginRender() {
  cursor = 0;
}

/** 执行本轮入队的 effect，返回 cleanup 列表。 */
export function __flushEffects() {
  const run = pending;
  pending = [];
  const cleanups = [];
  for (const fn of run) {
    const cleanup = fn();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return cleanups;
}

export function useState(initial) {
  const i = cursor++;
  if (!(i in slots)) slots[i] = { value: typeof initial === "function" ? initial() : initial };
  const cell = slots[i];
  const set = (next) => {
    cell.value = typeof next === "function" ? next(cell.value) : next;
    notify();
  };
  return [cell.value, set];
}

export function useRef(initial) {
  const i = cursor++;
  if (!(i in slots)) slots[i] = { current: initial };
  return slots[i];
}

export function useCallback(fn) {
  const i = cursor++;
  if (!(i in slots)) slots[i] = fn;
  return slots[i];
}

export function useEffect(fn, deps) {
  const i = cursor++;
  const prev = slots[i];
  const changed = !prev
    || !deps
    || deps.length !== (prev.deps ? prev.deps.length : -1)
    || deps.some((dep, j) => dep !== prev.deps[j]);
  slots[i] = { deps, fn };
  if (changed) pending.push(fn);
}
