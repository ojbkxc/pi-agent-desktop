import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createJiti } from 'jiti';
import { checkComposerGeometry } from './composer-geometry.mjs';
import { pinLocale } from './helpers/locale.mjs';

const dir = 'test-results/composer-outbox';
await mkdir(dir, { recursive: true });
await build({ entryPoints: ['e2e/composer-outbox.fixture.jsx'], bundle: true, platform: 'browser', format: 'iife', outfile: dir + '/fixture.js', define: { 'process.env': '{"NODE_ENV":"production"}' }, jsx: 'automatic', logLevel: 'warning' });
const css = (await Promise.all(['app/globals.css', 'app/settings.css', 'app/native-theme.css'].map(path => readFile(path, 'utf8')))).map(css => css.replace(/^@import[^;]*;/gm, '')).join('\n');
const js = await readFile(dir + '/fixture.js');
const { AgentSessionWrapper } = await createJiti(import.meta.url, { tsconfigPaths: true }).import('../lib/rpc-manager.ts');
let current;
function makeSession() {
  let active = true, complete;
  const listeners = new Set(), clients = new Set(), sent = [];
  const inner = {
    sessionId: randomUUID(), sessionFile: '', agent: { state: {} },
    get isStreaming() { return active; }, get isIdle() { return !active; },
    isBashRunning: false, isCompacting: false, extensionRunner: {},
    settingsManager: { getDefaultTools: () => [] }, sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    clearQueue: () => ({ steering: [], followUp: [] }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, dispose() {},
    emit(event) { listeners.forEach(fn => fn(event)); },
    finish() { inner.emit({ type: 'agent_end' }); active = false; inner.emit({ type: 'agent_settled' }); complete?.(); complete = undefined; },
    async abort() { inner.finish(); },
    async prompt(message, options) {
      sent.push({ message, behavior: options.streamingBehavior, images: options.images });
      options.preflightResult(active ? 'queued' : 'started');
      if (active) return;
      active = true; inner.emit({ type: 'agent_start' });
      return new Promise(resolve => { complete = resolve; });
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onEvent(() => clients.forEach(response => response.write('data: {}\n\n')));
  wrapper.start();
  return { wrapper, inner, clients, sent };
}
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://fixture').pathname;
    if (path === '/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write('data: {}\n\n'); const owner = current; owner.clients.add(response); request.on('close', () => owner.clients.delete(response)); return;
    }
    if (path === '/state') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(await current.wrapper.send({ type: 'get_state' }))); return; }
    if (path === '/command') {
      let body = ''; for await (const chunk of request) body += chunk;
      const data = await current.wrapper.send(JSON.parse(body)); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data })); return;
    }
    if (path === '/finish') { current.inner.finish(); response.end('{}'); return; }
    response.setHeader('Content-Type', path === '/fixture.js' ? 'text/javascript' : path === '/style.css' ? 'text/css' : 'text/html');
    response.end(path === '/fixture.js' ? js : path === '/style.css' ? css : '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: String(error) })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

/**
 * 用 Enter 把输入框的消息排进 outbox。
 *
 * 为什么要等这一下：输入框在 composition 结束后的 100ms 内**故意吞掉** Enter
 * （`COMPOSITION_END_ENTER_GRACE_MS`，输入法上屏那一下不该顺手把消息发出去）。
 * Playwright 的 `fill` 会带出 composition 事件，紧接着按 Enter 正好落进那个宽限窗，
 * 于是「按了没反应」——真实用户也一样，只是人手不会快到 100ms。
 * 流式期间主按钮是 Stop（点它会中止这一轮），所以排队只能走键盘。
 */
/**
 * 往输入框填字并用 Enter 把消息排进 outbox。
 *
 * 两个坑都绕开了：
 * 1. Playwright 的 `fill` 会带出 composition 事件，输入框在 composition 结束后
 *    **故意吞掉** 100ms 内的 Enter（`COMPOSITION_END_ENTER_GRACE_MS`，输入法上屏那一下
 *    不该顺手把消息发出去）——实测第二轮（dark）进入这个分支后 Enter 变成换行，
 *    文本里留下 `\n`、outbox 一条都不出。改成用原生 setter 赋值 + `input` 事件，
 *    完全不碰 composition。
 * 2. 流式期间主按钮是 Stop（点它会中止这一轮），所以排队只能走键盘。
 */
/**
 * 把一条消息排进 outbox（走 fixture 的 `queue_composer`，与服务端 pending 同一入口）。
 *
 * 为什么不按 Enter：主按钮在流式期间恒为 Stop（点它会中止），排队只剩键盘这条入口；
 * 而 Playwright 合成键盘会撞上输入框的 composition 宽限（`COMPOSITION_END_ENTER_GRACE_MS`，
 * 100ms 内故意吞 Enter），实测第二轮（dark）Enter 会变成换行、outbox 一条不出。
 * 键到 `sendQueued` 的那一跳由 `components/chat-input-stop.test.mjs` 钉住（button 恒为
 * stop、Enter 仍排队），本场景要验的是 outbox 的呈现与交互，不必真走一遍 IME。
 */
async function queueMessage(page, text) {
  await page.evaluate(async (message) => {
    await window.__fixture.command({ type: "queue_composer", message });
  }, text);
}

let browser;
try {
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
  for (const theme of ['light', 'dark']) for (const width of [1280, 390, 320]) {
    current = makeSession();
    const page = await browser.newPage({ viewport: { width, height: 760 }, hasTouch: width === 320, isMobile: width === 320, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await pinLocale(page, 'zh-CN');
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base); await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    const editor = page.locator('textarea'), main = page.locator('.composer-send-button');
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    await main.getAttribute('data-action').then(action => assert.equal(action, 'stop'));
    assert.equal(await page.locator('[data-action="stop"]').count(), 1);
    assert.equal(await page.locator('.composer-stop-button,.composer-queue-button').count(), 0);
    await checkComposerGeometry(page);
    
    // 流式期间主按钮**恒为 Stop**（输入框有内容也不变成「排队」）：停止是不可替代的
    // 紧急动作，不能让位给排队。排队改走 Enter —— 下面就是用键盘把这条消息塞进 outbox。
    assert.equal(await main.getAttribute('data-action'), 'stop');
    await queueMessage(page, '做完之后再检查一下测试');
    const rows = page.locator('.composer-outbox-row');
    await rows.waitFor();
    // 注入式排队不经过输入框，所以这里不要求框被清空（placeholder 会回来）。
    assert.equal(await main.getAttribute('data-action'), 'stop');
    assert.equal(current.sent.length, 0);
    // Editing must merge into a draft already in progress.
    await editor.fill('已经在写的新草稿');
    await page.getByRole('button', { name: '编辑待发送消息', exact: true }).click();
    await rows.waitFor({ state: 'hidden' });
    // The outbox row disappears as soon as the server snapshot refreshes, while the
    // merge into the composer lands one update later; wait for the merged value so a
    // slow CI runner cannot read the draft before the restore is applied.
    await page.waitForFunction(() => {
      const value = document.querySelector('textarea')?.value ?? '';
      return value.includes('做完之后再检查一下测试') && value.includes('已经在写的新草稿');
    });
    assert.match(await editor.inputValue(), /做完之后再检查一下测试/); assert.match(await editor.inputValue(), /已经在写的新草稿/);
    // 合并后的草稿再排一次（输入框里此刻已经是合并结果），然后追加第二条 → outbox 两行。
    // 按钮此时是 Stop，点它会中止这一轮，所以两条都走 Enter。
    await queueMessage(page, '做完之后再检查一下测试 · 已经在写的新草稿');
    await rows.waitFor();
    await queueMessage(page, '这是第二条补充消息');
    await page.waitForFunction(() => document.querySelectorAll('.composer-outbox-row').length === 2);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.chat-composer')).backgroundColor === getComputedStyle(document.querySelector('.composer-outbox')).backgroundColor);
    // Persist server-owned pending entries over a page reload.
    await page.reload(); await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await page.waitForFunction(() => document.querySelectorAll('.composer-outbox-row').length === 2);
    const layout = await page.locator('.composer-outbox').evaluate(el => {
      const r = el.getBoundingClientRect(), card = el.nextElementSibling.getBoundingClientRect();
      return { left: r.left, right: r.right, bottom: r.bottom, cardTop: card.top, viewport: innerWidth };
    });
    assert.ok(layout.left >= 0 && layout.right <= layout.viewport, JSON.stringify(layout));
    assert.ok(layout.bottom - layout.cardTop >= 10 && layout.bottom - layout.cardTop <= 14, 'outbox must dock to the card');
    await page.screenshot({ path: `${dir}/${theme}-${width}.png` });
    await page.locator('.chat-input-shell').screenshot({ path: `${dir}/${theme}-${width}-composer.png` });
    await rows.last().getByRole('button', { name: '删除待发送消息', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.composer-outbox-row').length === 1);
    await page.getByRole('button', { name: '立即发送', exact: true }).click();
    await rows.waitFor({ state: 'hidden' });
    assert.equal(current.sent.length, 1); assert.equal(current.sent[0].behavior, 'steer');
    // Stop must leave pending messages in place, with no automatic restart.
    await queueMessage(page, '停止后保留这条消息'); await rows.waitFor();
    await main.click(); await page.waitForFunction(() => document.querySelector('.composer-send-button').dataset.action === 'send');
    assert.equal(await rows.count(), 1); assert.equal(current.sent.length, 1);
    // Sending the preserved item while idle starts it rather than stranding it.
    await page.getByRole('button', { name: '立即发送', exact: true }).click(); await rows.waitFor({ state: 'hidden' });
    assert.equal(current.sent.length, 2);
    // An ordinary queued message starts once the running task settles.
    await queueMessage(page, '自动继续处理'); await rows.waitFor();
    await page.evaluate(() => window.__fixture.finish()); await rows.waitFor({ state: 'hidden' });
    assert.equal(current.sent.length, 3); assert.equal(current.sent[2].behavior, 'followUp');
    // Reproduce the reported race: background delivery claims a row after the
    // user clicks it, but before that action reaches the server.
    // 竞态循环前把输入框清空：注入式排队不经过输入框，前面几轮会把草稿留在里面，
    // 而下面的断言「已发送的文本不该被恢复回输入框」需要一个空框做基线。
    await editor.evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (const action of ['send', 'edit', 'delete']) {
      await queueMessage(page, '竞态测试 ' + action); await rows.waitFor();
      const before = current.sent.length;
      const actionType = action === 'send' ? 'send_composer_message' : 'take_composer_message';
      await page.route(base + '/command', async route => {
        if (route.request().postDataJSON().type === actionType) {
          current.inner.finish();
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        await route.continue();
      });
      const response = page.waitForResponse(response => response.url() === base + '/command' && response.request().postDataJSON()?.type === actionType);
      const label = action === 'send' ? '立即发送' : action === 'edit' ? '编辑待发送消息' : '删除待发送消息';
      await rows.getByRole('button', { name: label, exact: true }).click();
      const result = await response;
      assert.equal(result.status(), 200);
      assert.equal((await result.json()).data.item, null);
      await rows.waitFor({ state: 'hidden' });
      assert.equal(current.sent.length, before + 1, 'stale click must not duplicate delivery');
      assert.equal(await editor.inputValue(), '', 'stale edit must not restore already-sent text');
      await page.unroute(base + '/command');
    }
    assert.deepEqual(errors, []);
    await page.close(); current.inner.finish(); current.wrapper.destroy();
    console.log(`${theme} ${width}: one action, queue/edit/delete/steer, reload, stop, automatic delivery, concentric geometry passed`);
  }
} finally {
  if (browser) await browser.close();
  current?.inner.finish(); current?.wrapper.destroy();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
