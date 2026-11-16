import { exportPrivateKey, generateKeyPair, keyPairFromPrivate, type KeyPair } from "../lib/relay/noise.ts";
import { PhoneTunnel, pairPhone, parsePairingTicket, type PhoneConfig } from "../lib/relay/phone-client.ts";
import {
  attentionHref,
  attentionItemMeta,
  attentionItemTitle,
  attentionPreview,
  parseAttentionResponse,
  relativeAge,
  type AttentionItem,
  type AttentionSnapshot,
} from "./home.ts";
import { safeAppPath } from "./paths.ts";

/**
 * The phone shell (docs/remote-relay.md): served by the entry host at /__shell/,
 * it holds the encrypted session to the desktop and frames the Pi app, whose
 * every request the tunnel service worker hands back here.
 */

const DB_NAME = "pi-relay";
const STORE = "config";
const KEY = "phone";

/**
 * The build id stamped by scripts/build-relay-shell.mjs (second pass, define).
 * A hand-run bundle or an unbuilt import has no define and falls back to
 * "dev". Printed once so a deployment can be checked from the phone's
 * devtools console against the file name served at /__shell/ (deploy docs:
 * "verify the shell version").
 */
declare const __SHELL_BUILD__: string;
const SHELL_BUILD: string = typeof __SHELL_BUILD__ === "string" ? __SHELL_BUILD__ : "dev";

interface StoredConfig {
  relayUrl: string;
  agentId: string;
  desktopKey: Uint8Array;
  /** Non-extractable key, where the browser can keep a CryptoKey in IndexedDB. */
  devicePrivate?: CryptoKey;
  /** Raw private key, where it cannot (see canKeepCryptoKeys). */
  devicePrivateRaw?: Uint8Array;
  devicePublic: Uint8Array;
  deviceId: string;
  pairedAt: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(): Promise<StoredConfig | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve((request.result as StoredConfig | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function dbPut(value: StoredConfig | null): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    if (value) tx.objectStore(STORE).put(value, KEY);
    else tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Whether a CryptoKey survives a round trip through IndexedDB here. Safari keeps
 * one by wrapping it with a keychain key; where that is unavailable (seen in
 * Playwright's WebKit) it stores null, and a non-extractable key would be lost on
 * the next launch. Then the device key is kept as raw bytes instead: same-origin
 * script could copy it rather than only use it, which is the price of not
 * silently forgetting the pairing.
 */
async function canKeepCryptoKeys(): Promise<boolean> {
  try {
    const probe = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]) as CryptoKeyPair;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ probe: probe.privateKey }, "probe");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const value = await new Promise<{ probe?: unknown } | undefined>((resolve) => {
      const request = db.transaction(STORE).objectStore(STORE).get("probe");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
    db.transaction(STORE, "readwrite").objectStore(STORE).delete("probe");
    return value?.probe instanceof CryptoKey;
  } catch {
    return false;
  }
}

function show(screen: "pair" | "unpaired" | "app" | "home" | "message", text?: string): void {
  // "boot" is the one screen index.html shows by itself; it stays up while
  // shell.js loads and goes away the moment any real screen takes over. If
  // shell.js never runs, boot keeps saying so instead of a silent blank page.
  for (const id of ["boot", "pair", "unpaired", "app", "home", "message"]) $(`screen-${id}`).hidden = id !== screen;
  $("home-open").hidden = screen !== "home";
  // The way back to the dashboard is only there once the frame has loaded.
  $("app-home").hidden = screen !== "app" || !($("app-frame") as HTMLIFrameElement).getAttribute("src");
  if (screen !== "home") stopHomePolling();
  setAppScreenUp(screen === "app");
  if (text !== undefined) $("message-text").textContent = text;
}

/**
 * The background chip on the app screen: "N need you" while the dashboard's
 * last poll found anyone waiting. Kept from a lightweight timer that only runs
 * while the app screen is up, so the tunnel carries one small request a minute.
 */
const FEED_CHECK_MS = 60_000;
let feedTimer: ReturnType<typeof setTimeout> | null = null;
let feedController: AbortController | null = null;
let appScreenUp = false;

function updateFeedNote(awaitingCount: number): void {
  const note = $("feed-note");
  if (!appScreenUp || awaitingCount === 0) {
    note.hidden = true;
    return;
  }
  note.hidden = false;
  note.textContent = awaitingCount === 1 ? "1 needs you — open the dashboard" : `${awaitingCount} need you — open the dashboard`;
}

function stopFeedCheck(): void {
  appScreenUp = false;
  feedController?.abort();
  feedController = null;
  if (feedTimer) clearTimeout(feedTimer);
  feedTimer = null;
  $("feed-note").hidden = true;
}

async function checkFeed(): Promise<void> {
  if (!appScreenUp) return;
  // A paused check (hidden tab) may still hold the abort controller; a new one
  // starts from scratch.
  if (feedTimer) clearTimeout(feedTimer);
  feedTimer = null;
  feedController?.abort();
  const controller = new AbortController();
  feedController = controller;
  try {
    const snapshot = await fetchAttention(controller.signal);
    if (!controller.signal.aborted) updateFeedNote(snapshot?.awaiting.length ?? 0);
  } catch {
    // A failed check says nothing new; the chip keeps its last state.
  }
  if (appScreenUp) feedTimer = setTimeout(() => void checkFeed(), FEED_CHECK_MS);
}

function setAppScreenUp(up: boolean): void {
  appScreenUp = up;
  if (feedTimer) clearTimeout(feedTimer);
  feedTimer = null;
  if (up) void checkFeed();
  else stopFeedCheck();
}

function setStatus(state: "connecting" | "open" | "offline", detail = ""): void {
  const pill = $("status");
  pill.dataset.state = state;
  $("status-text").textContent = state === "open" ? "Connected" : state === "connecting" ? "Connecting…" : `Offline${detail ? ` · ${detail}` : ""}`;
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  return "Browser";
}

// ---- requests from the tunnel service worker ----

let tunnel: PhoneTunnel | null = null;
const waitingForTunnel: (() => void)[] = [];

function tunnelReady(timeoutMs: number): Promise<PhoneTunnel | null> {
  if (tunnel?.state === "open") return Promise.resolve(tunnel);
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      resolve(tunnel?.state === "open" ? tunnel : null);
    };
    const timer = setTimeout(() => {
      // Timed out without a tunnel: drop the wake, or a long offline stretch
      // accumulates one closure per queued request, all to be resolved to
      // nothing the next time the tunnel opens.
      const index = waitingForTunnel.indexOf(wake);
      if (index !== -1) waitingForTunnel.splice(index, 1);
      resolve(null);
    }, timeoutMs);
    waitingForTunnel.push(wake);
  });
}

async function serve(message: { method: string; url: string; headers: [string, string][]; body: ArrayBuffer | null }, port: MessagePort): Promise<void> {
  // A window without a pairing (a pairing page, say) never answers: the worker then
  // asks the window that has one instead of waiting on this one.
  if (!config) return;
  const controller = new AbortController();
  port.onmessage = (event) => { if (event.data?.type === "cancel") controller.abort(); };
  // Tell the worker this window is alive and has the request; it tries another window otherwise.
  port.postMessage({ type: "ack" });
  const ready = await tunnelReady(15_000);
  if (!ready) {
    port.postMessage({ type: "error", status: 503, message: "Not connected to your computer." });
    return;
  }
  try {
    const { head, body } = await ready.request(
      { method: message.method, url: message.url, headers: message.headers },
      message.body ? new Uint8Array(message.body) : undefined,
      controller.signal,
    );
    port.postMessage({ type: "head", status: head.status, headers: head.headers });
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.slice().buffer;
      port.postMessage({ type: "chunk", data: chunk }, [chunk]);
    }
    port.postMessage({ type: "end" });
  } catch (error) {
    if (!controller.signal.aborted) port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

navigator.serviceWorker?.addEventListener("message", (event) => {
  const data = event.data as { type?: string; path?: string };
  if (data?.type === "pi-tunnel-request" && event.ports[0]) {
    void serve(event.data, event.ports[0]);
  } else if (data?.type === "pi-open-path" && config) {
    // A notification click lands on the page it announces, home dashboard or not.
    loadFrame(data.path ?? "/");
  }
});

// ---- connection lifecycle ----

let config: PhoneConfig | null = null;
let retryMs = 1000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let connecting = false;

async function connect(): Promise<void> {
  if (!config || connecting || tunnel?.state === "open") return;
  connecting = true;
  if (retryTimer) clearTimeout(retryTimer);
  setStatus("connecting");
  const next = new PhoneTunnel(config);
  try {
    await next.connect();
    tunnel = next;
    retryMs = 1000;
    setStatus("open");
    navigator.serviceWorker.controller?.postMessage({ type: "pi-shell-ready" });
    for (const wake of waitingForTunnel.splice(0)) wake();
    // A dashboard row tapped while connecting opens the moment the tunnel is up.
    openPendingPath();
    // Watched from the dashboard: a reconnect brings the lists back by itself.
    if (homeVisible) void startHomeRefresh();
    next.onClose = (error) => {
      if (tunnel === next) tunnel = null;
      if (error.code === 4001) return showUnpaired();
      setStatus("offline", error.code === 4404 ? "computer offline" : "");
      scheduleReconnect();
    };
  } catch (error) {
    const code = (error as { code?: number }).code;
    // 4001: the desktop does not know this phone's key (removed). 4404: the desktop is
    // not connected to the relay. Anything else (limits, restarts) is worth a retry.
    if (code === 4001) return showUnpaired();
    setStatus("offline", code === 4404 ? "computer offline" : "");
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function showUnpaired(): void {
  setStatus("offline", "this phone was removed");
  show("message", "This phone is no longer paired with your computer. Pair it again from Settings › Remote relay on the computer.");
}

function scheduleReconnect(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void connect(), retryMs);
  retryMs = Math.min(retryMs * 2, 15_000);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  // Coming back: refresh whichever list was on screen instead of waiting for
  // a paused timer, and retry the tunnel if it is down.
  if (homeVisible) void startHomeRefresh();
  if (appScreenUp) void checkFeed();
  if (tunnel?.state !== "open") {
    retryMs = 1000;
    void connect();
  }
});
window.addEventListener("online", () => { retryMs = 1000; void connect(); });

async function registerWorker(): Promise<void> {
  await navigator.serviceWorker.register("/tunnel-sw.js", { scope: "/", updateViaCache: "none" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  }
}

function initialPath(): string {
  return safeAppPath(new URLSearchParams(location.search).get("path") ?? "/");
}

// ---- home dashboard ----

const HOME_REFRESH_MS = 15_000;
let homeTimer: ReturnType<typeof setTimeout> | null = null;
let homeVisible = false;
/** A row tapped before the tunnel came up: open it once the connection is there. */
let pendingOpenPath: string | null = null;

function stopHomePolling(): void {
  homeVisible = false;
  if (homeTimer) clearTimeout(homeTimer);
  homeTimer = null;
}

/**
 * The frame is loaded lazily: a phone that only glances at the dashboard never
 * hydrates the whole app, so the encrypted tunnel carries one small request.
 * The frame stays in the DOM once loaded (screens hide, never unmount), so
 * opening it again keeps its state.
 */
function loadFrame(path: string): void {
  const frame = $("app-frame") as HTMLIFrameElement;
  const safe = safeAppPath(path);
  if (!frame.getAttribute("src")) frame.src = safe;
  else frame.contentWindow?.location.replace(safe);
  show("app");
  // Same-session rows (a reload of the frame) never fire a `load`; the way
  // back is usable as soon as the frame element has an address.
  $("app-home").hidden = false;
}

async function fetchAttention(signal: AbortSignal): Promise<AttentionSnapshot | null> {
  const ready = await tunnelReady(10_000);
  if (!ready) return null;
  const { head, body } = await ready.request(
    { method: "GET", url: "/api/attention", headers: [] },
    undefined,
    signal,
  );
  if (head.status !== 200) throw new Error(`HTTP ${head.status}`);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    // The dashboard shows at most a couple of hundred short rows; anything
    // larger is not that route answering, so stop reading.
    if (size > 512 * 1024) {
      await reader.cancel();
      throw new Error("attention payload too large");
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return parseAttentionResponse(JSON.parse(new TextDecoder().decode(bytes)));
}

function homeRow(item: AttentionItem, now: number): HTMLLIElement {
  const row = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "home-row";
  button.dataset.tone = item.kind === "awaiting-input" ? "attention" : "done";
  button.dataset.sessionId = item.sessionId;

  const title = document.createElement("span");
  title.className = "home-row-title";
  title.textContent = attentionItemTitle(item);
  button.append(title);

  const meta = document.createElement("span");
  meta.className = "home-row-meta";
  meta.textContent = attentionItemMeta(item, now);
  button.append(meta);

  const preview = attentionPreview(item);
  if (preview) {
    const body = document.createElement("span");
    body.className = "home-row-preview";
    body.textContent = preview;
    button.append(body);
  }
  button.addEventListener("click", () => openSession(item.sessionId));
  row.append(button);
  return row;
}

function homeEmpty(text: string, action?: { label: string; onClick: () => void }): HTMLLIElement {
  const row = document.createElement("li");
  const box = document.createElement("div");
  box.className = "home-empty";
  box.textContent = text;
  if (action) {
    box.append(" ");
    const link = document.createElement("button");
    link.type = "button";
    link.className = "home-link";
    link.textContent = action.label;
    link.addEventListener("click", action.onClick);
    box.append(link);
  }
  row.append(box);
  return row;
}

function renderHome(snapshot: AttentionSnapshot | null): void {
  const now = Date.now();
  const awaiting = $("home-awaiting");
  const completed = $("home-completed");
  const status = $("home-status");
  const error = $("home-error");
  awaiting.replaceChildren();
  completed.replaceChildren();
  error.hidden = true;
  error.textContent = "";
  $("home-awaiting-count").textContent = "";
  if (!snapshot) {
    status.textContent = "Not connected to your computer.";
    error.hidden = false;
    error.textContent = "The dashboard needs the encrypted connection. It reconnects by itself; tap Refresh to try now, or open the full app.";
    awaiting.append(homeEmpty("Waiting…"));
    completed.append(homeEmpty("Waiting…"));
    return;
  }
  status.textContent = `Updated ${relativeAge(now, snapshot.generatedAt || now)}`;
  $("home-awaiting-count").textContent = snapshot.awaiting.length ? `(${snapshot.awaiting.length})` : "";
  if (snapshot.awaiting.length) {
    for (const item of snapshot.awaiting) awaiting.append(homeRow(item, now));
  } else {
    awaiting.append(homeEmpty("Nothing needs you right now.", { label: "Open the full app", onClick: () => loadFrame("/") }));
  }
  if (snapshot.completed.length) {
    for (const item of snapshot.completed) completed.append(homeRow(item, now));
  } else {
    completed.append(homeEmpty("Nothing finished lately."));
  }
}

async function refreshHome(signal: AbortSignal): Promise<void> {
  try {
    renderHome(await fetchAttention(signal));
  } catch (error) {
    if (signal.aborted) return;
    console.warn("[pi-shell] attention fetch failed:", error instanceof Error ? error.message : error);
    renderHome(null);
    return;
  }
  if (!homeVisible) return;
  if (homeTimer) clearTimeout(homeTimer);
  // The dashboard polls only while someone is looking at it.
  homeTimer = setTimeout(() => {
    if (homeVisible && document.visibilityState === "visible") void startHomeRefresh();
  }, HOME_REFRESH_MS);
}

let homeController: AbortController | null = null;

async function startHomeRefresh(): Promise<void> {
  homeController?.abort();
  const controller = new AbortController();
  homeController = controller;
  await refreshHome(controller.signal);
}

function showHome(): void {
  homeVisible = true;
  show("home");
  void startHomeRefresh();
}

/**
 * Open one session in the full app. The app's own `?session=` deep link lands
 * on that chat; the sidebar restores it once the session list has loaded, and
 * falls back to the project's picker when the session is gone (the picker is
 * the app's own behaviour for a missing id). The path only depends on our
 * parsing, so it cannot smuggle an /api/ URL (relay-shell/paths.ts).
 */
function openSession(sessionId: string): void {
  if (!config) return;
  const path = safeAppPath(attentionHref(sessionId));
  if (tunnel?.state === "open") {
    loadFrame(path);
    return;
  }
  // The tunnel is still coming up (pairing just finished, or a reconnect): keep
  // the choice and open it as soon as it is there instead of silently dropping it.
  homeStatus("Connecting…");
  pendingOpenPath = path;
}

function openPendingPath(): void {
  if (!pendingOpenPath) return;
  const path = pendingOpenPath;
  pendingOpenPath = null;
  loadFrame(path);
}

function homeStatus(text: string): void {
  if (!homeVisible) return;
  $("home-status").textContent = text;
}

$("home-open").addEventListener("click", () => loadFrame("/"));
$("home-refresh").addEventListener("click", () => void startHomeRefresh());
$("app-home").addEventListener("click", () => {
  if (config) showHome();
});
$("feed-note").addEventListener("click", () => {
  if (config) showHome();
});

async function startApp(stored: StoredConfig): Promise<void> {
  const privateKey = stored.devicePrivate instanceof CryptoKey
    ? stored.devicePrivate
    : stored.devicePrivateRaw ? (await keyPairFromPrivate(stored.devicePrivateRaw, false)).privateKey : null;
  if (!privateKey) {
    show("message", "This phone lost its pairing key. Pair it again from Settings › Remote relay on the computer.");
    return;
  }
  config = {
    relayUrl: stored.relayUrl,
    agentId: stored.agentId,
    desktopKey: stored.desktopKey,
    device: { privateKey, publicKey: stored.devicePublic },
    deviceId: stored.deviceId,
  };
  // A notification click (`?path=`) named a page: go straight there, as before.
  // Everything else lands on the dashboard first; the full app is one tap away.
  const requestedPath = initialPath();
  show(requestedPath === "/" ? "home" : "app");
  $("status").hidden = false;
  await registerWorker();
  await connect();
  if (requestedPath === "/") {
    // Show the dashboard shell at once; its first fetch resolves as soon as the
    // tunnel is up (tunnelReady inside fetchAttention), and connect() refreshes
    // it again when it opens.
    showHome();
  } else {
    ($("app-frame") as HTMLIFrameElement).src = requestedPath;
    $("app-home").hidden = false;
  }
}

async function runPairing(ticketText: string): Promise<void> {
  const ticket = parsePairingTicket(ticketText);
  // The secret is in the fragment; drop it from the address bar and history now.
  history.replaceState(null, "", location.pathname);
  if (!ticket) {
    show("message", "This pairing link is not valid. Create a new QR code on your computer.");
    return;
  }
  // Any site can open a pairing link. Pairing over an existing pairing replaces this
  // phone's key and points it at another computer, so it has to be meant.
  const existing = await dbGet();
  const replace = $("pair-replace");
  replace.hidden = !existing;
  $<HTMLInputElement>("pair-replace-check").checked = false;
  show("pair");
  const nameInput = $<HTMLInputElement>("pair-name");
  nameInput.value = defaultDeviceName();
  const button = $<HTMLButtonElement>("pair-button");
  const status = $("pair-status");
  button.onclick = async () => {
    if (existing && !$<HTMLInputElement>("pair-replace-check").checked) {
      status.textContent = "This phone is already paired. Tick the box to replace that pairing, or close this page.";
      return;
    }
    button.disabled = true;
    status.textContent = "Connecting to your computer…";
    try {
      const keepKey = await canKeepCryptoKeys();
      const device: KeyPair = await generateKeyPair(!keepKey);
      const { deviceId } = await pairPhone({
        ticket,
        device,
        name: nameInput.value,
        onWaitingForApproval: (code) => {
          status.textContent = `On your computer, allow this phone only if it shows the code ${code.slice(0, 3)} ${code.slice(3)}.`;
        },
      });
      const stored: StoredConfig = {
        relayUrl: ticket.relayUrl,
        agentId: ticket.agentId,
        desktopKey: ticket.desktopKey,
        ...(keepKey ? { devicePrivate: device.privateKey } : { devicePrivateRaw: await exportPrivateKey(device) }),
        devicePublic: device.publicKey,
        deviceId,
        pairedAt: new Date().toISOString(),
      };
      await dbPut(stored);
      await startApp(stored);
    } catch (error) {
      status.textContent = error instanceof Error && error.message !== "relay connection closed (1006)"
        ? error.message
        : "Pairing failed. The QR code may have expired; create a new one on your computer.";
      button.disabled = false;
    }
  };
}

$("forget-button").addEventListener("click", async () => {
  if (!confirm("Unpair this phone? You will need to scan a new QR code on your computer.")) return;
  tunnel?.close();
  await dbPut(null);
  location.replace("/__shell/");
});
$("status").addEventListener("click", () => {
  const menu = $("menu");
  menu.hidden = !menu.hidden;
});
$("reconnect-button").addEventListener("click", () => {
  $("menu").hidden = true;
  retryMs = 1000;
  void connect();
});

async function main(): Promise<void> {
  // Deployment check (deploy docs: "verify the shell version"): the console
  // line must match the shell-<id>.js file the entry host serves.
  console.info(`[pi-shell] build ${SHELL_BUILD}`);
  // Framed by another page: refuse (no frame-ancestors from a static host's meta tags).
  if (window.top !== window.self) {
    document.body.textContent = "Pi cannot run inside another page.";
    return;
  }
  if (!("serviceWorker" in navigator) || !crypto?.subtle) {
    show("message", "This browser cannot run Pi remotely. Use Safari (iOS 17 or later) or a current Chrome.");
    return;
  }
  try {
    await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
  } catch {
    show("message", "This browser lacks X25519 encryption. Update to iOS 17 or later, or a current Chrome.");
    return;
  }
  if (location.hash.includes("pair=")) return runPairing(location.hash);
  const stored = await dbGet();
  if (stored) return startApp(stored);
  show("unpaired");
}

void main();
