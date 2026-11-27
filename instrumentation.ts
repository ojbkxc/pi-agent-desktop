export async function register(): Promise<void> {
  // Next builds this file for both the Node and the Edge instrumentation entry.
  // The Edge graph rejects Node APIs, so `process.on` and undici live in
  // ./instrumentation-node, reached only through this compile-time-eliminated
  // NEXT_RUNTIME branch. An early `return` instead of this `if` would leave the
  // Node calls in the Edge module.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // 这两段各自可能很贵，分开记账才能定位（实测 `Ready` 到第一条 `[public-access]` 之间有
    // 3.5 秒零日志，而 `applyNetworkProxy` 只占 45ms、各子系统也都 <200ms —— 差值就在
    // **这个动态 import** 上：它要一次拉起 scheduler / autofix / campaign / keepalive /
    // relay / public-access 那几百个模块）。
    const importStartedAt = Date.now();
    const { registerNodeInstrumentation } = await import("./instrumentation-node");
    const importMs = Date.now() - importStartedAt;
    if (importMs >= 50) {
      console.error(`[Pi Agent] instrumentation: import took ${importMs} ms`);
    }
    const registerStartedAt = Date.now();
    registerNodeInstrumentation();
    const registerMs = Date.now() - registerStartedAt;
    if (registerMs >= 50) {
      console.error(`[Pi Agent] instrumentation: register took ${registerMs} ms`);
    }
  }
}