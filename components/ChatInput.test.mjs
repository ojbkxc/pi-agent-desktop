import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput, ModelErrorBanner, ModelScopeWarningBanner, canClearBuiltinCommandInput, canRestoreUserMessage, canRunBuiltinSlashCommandWhileStreaming, compressImageFile, cycleListIndex, filterModelOptions, getTopbarBoundary, getUpwardMenuMaxHeight, getUserMessageText, getUserMessageDraftImages, isExactSlashCommand, modelSupportsImageInput, pendingTypedSuffix, replaceLinksWithMarkdown, resolveImageLanding, shouldCompressImageFile, offersBuiltinSlashCommandWhileStreaming, submitsSlashCommandOnEnter, userMessageRequestsAgentTeam} = await jiti.import("./ChatInput.tsx");

const { isBareMcpCommand } = await jiti.import("@/lib/mcp-command.ts");
const { composeMessageWithAttachedFiles, splitMessageForComposer } = await jiti.import("@/lib/chat-attachments.ts");
const { withAgentTeamRequest, hasAgentTeamRequest } = await jiti.import("@/lib/agent-team-request.ts");
const { shouldDisarmAgentTeam, armAgentTeam, disarmAgentTeam, isAgentTeamsArmed } = await jiti.import("@/hooks/useAgentTeamsEnabled.ts", { default: false });
const { ModelSelector } = await jiti.import("./ModelSelector.tsx");
const { clearDraft, getDraft, mergeRestoredSubmissionDraft, mergeRestoredSubmissionText, rekeyDraft, setDraft } = await jiti.import("@/lib/draft-store");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderWithI18n(element) {
  return renderToStaticMarkup(React.createElement(I18nProvider, { initialLocale: "en" }, element));
}

test("renders the upstream model error", () => {
  const html = renderWithI18n(
    React.createElement(ModelErrorBanner, {
      error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
    }),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Model error/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(renderWithI18n(React.createElement(ModelErrorBanner, { error: null })), "");
});

test("renders enabledModels scope warnings with a dismiss control", () => {
  const html = renderWithI18n(
    React.createElement(ModelScopeWarningBanner, {
      warnings: [
        { code: "no-match", pattern: "ghost-gateway/*", message: "No models match pattern \"ghost-gateway/*\"" },
      ],
      onDismiss() {},
      dismissLabel: "Dismiss",
    }),
  );

  assert.match(html, /Model scope warning/);
  assert.match(html, /No models match pattern/);
  assert.match(html, /ghost-gateway/);
  assert.match(html, /aria-label="Dismiss"/);
  // No configure entry for plain no-match warnings.
  assert.doesNotMatch(html, /Configure providers/);
  assert.equal(renderWithI18n(React.createElement(ModelScopeWarningBanner, { warnings: [] })), "");
  assert.equal(renderWithI18n(React.createElement(ModelScopeWarningBanner)), "");
});

test("rewords unauthenticated-provider warnings and offers the configure entry (#48)", () => {
  const html = renderWithI18n(
    React.createElement(ModelScopeWarningBanner, {
      warnings: [
        {
          code: "unauthenticated-provider",
          pattern: "acme-gateway/claude-opus-4-8",
          unauthenticatedProviders: ["acme-gateway"],
          message: "No models match pattern \"acme-gateway/claude-opus-4-8\"",
        },
      ],
      onDismiss() {},
      dismissLabel: "Dismiss",
      onOpenModelsConfig() {},
    }),
  );

  assert.match(html, /has no usable credentials/);
  assert.match(html, /acme-gateway/);
  // The raw resolver message must not leak through for classified warnings.
  assert.doesNotMatch(html, /No models match pattern/);
  assert.match(html, /Configure providers/);
  assert.match(html, /aria-label="Dismiss"/);
});

test("preserves pasted HTML links as Markdown without changing plain text layout", () => {
  const link = (label, href, occurrence = 0) => ({ label, href, occurrence });

  assert.equal(
    replaceLinksWithMarkdown(
      "Jobs:\nEngineer\nEngineer\nDone",
      [link("Engineer", "https://example.com/1"), link("Engineer", "https://example.com/2", 1)],
    ),
    "Jobs:\n[Engineer](https://example.com/1)\n[Engineer](https://example.com/2)\nDone",
  );
  assert.equal(
    replaceLinksWithMarkdown("Read [this]", [link("[this]", "https://example.com/a_(b)")]),
    "Read [\\[this\\]](https://example.com/a_\\(b\\))",
  );
  assert.equal(
    replaceLinksWithMarkdown("Engineer and Engineer", [link("Engineer", "https://example.com/job", 1)]),
    "Engineer and [Engineer](https://example.com/job)",
  );
  assert.equal(replaceLinksWithMarkdown("plain text", [link("missing", "https://example.com")]), null);
});

test("follow-up shortcuts preserve newline, IME, mobile and completion behavior", () => {
  const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findHandler(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleKeyDown") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findHandler);
  }
  // Execute the component's actual callback without mounting the rest of the UI.
  const script = new Script(ts.transpileModule(findHandler(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  const cases = [
    ["Enter queues a follow-up", {}, {}, "followup"],
    ["Alt+Enter follows up", { altKey: true }, {}, "followup"],
    ["idle Alt+Enter sends", { altKey: true }, { isStreaming: false }, "send"],
    ["Shift+Enter inserts a newline", { shiftKey: true }, {}, "native"],
    ["Alt+Shift+Enter keeps native behavior", { altKey: true, shiftKey: true }, {}, "native"],
    ["composition ref blocks sending", { altKey: true }, { isComposingRef: { current: true } }, "native"],
    ["native composition blocks sending", { altKey: true, nativeEvent: { isComposing: true } }, {}, "native"],
    ["IME keyCode blocks sending", { altKey: true, nativeEvent: { keyCode: 229 } }, {}, "native"],
    ["composition grace blocks sending", { altKey: true }, { lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["mobile Alt+Enter keeps native behavior", { altKey: true }, { isMobile: true }, "native"],
    ["mobile composition grace cannot send", { altKey: true }, { isMobile: true, lastCompositionEndAtRef: { current: 950 } }, "native"],
    ["mobile Ctrl+Alt+Enter follows up", { altKey: true, ctrlKey: true }, { isMobile: true }, "followup"],
    ["mobile Cmd+Alt+Enter follows up", { altKey: true, metaKey: true }, { isMobile: true }, "followup"],
    ["mobile modified Enter respects composition grace", { altKey: true, ctrlKey: true }, { isMobile: true, lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["Enter falls back to follow-up", {}, { onSteer: undefined }, "followup"],
    ["Alt+Enter falls back to steer", { altKey: true }, { onFollowUp: undefined }, "steer"],
    ["slash completion takes priority", { altKey: true }, { slashMenuOpen: true, slashQuery: "help" }, "slash"],
    ["available built-in commands take priority", { altKey: true }, { slashMenuOpen: true, slashQuery: "copy", value: "/copy", displayedSlashCommands: [{ name: "copy", source: "builtin", availableWhileStreaming: true }] }, "send"],
    ["pi's built-in /mcp submits at once, also while streaming", {}, { slashMenuOpen: true, slashQuery: "mcp", value: "/mcp", displayedSlashCommands: [{ name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp" } }] }, "send"],
    ["another extension's /mcp completes first", {}, { slashMenuOpen: true, slashQuery: "mcp", value: "/mcp", displayedSlashCommands: [{ name: "mcp", source: "extension", sourceInfo: { path: "/ext/mcp.ts" } }] }, "slash"],
    ["file completion takes priority", { altKey: true }, { atMenuOpen: true, atQuery: {} }, "file"],
    ["history selection takes priority", { altKey: true }, { historyMenuOpen: true }, "history"],
    ["Ctrl+Enter mode: Enter inserts a newline", {}, { enterSendMode: "ctrlEnter", isStreaming: false }, "native"],
    ["Ctrl+Enter mode: Ctrl+Enter sends", { ctrlKey: true }, { enterSendMode: "ctrlEnter", isStreaming: false }, "send"],
    ["Ctrl+Enter mode: Cmd+Enter queues a follow-up", { metaKey: true }, { enterSendMode: "ctrlEnter" }, "followup"],
    ["Ctrl+Enter mode: composition grace blocks the newline", {}, { enterSendMode: "ctrlEnter", lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["Ctrl+Enter mode: Enter picks a file", {}, { enterSendMode: "ctrlEnter", atMenuOpen: true, atQuery: {} }, "file"],
    ["Ctrl+Enter mode: Enter picks from history", {}, { enterSendMode: "ctrlEnter", historyMenuOpen: true }, "history"],
    ["Ctrl+Enter mode: Enter completes an exact slash command instead of sending it", {}, { enterSendMode: "ctrlEnter", isStreaming: false, slashMenuOpen: true, slashQuery: "copy", value: "/copy", displayedSlashCommands: [{ name: "copy", source: "builtin" }] }, "slash"],
    ["Ctrl+Enter mode: Ctrl+Enter sends an exact slash command", { ctrlKey: true }, { enterSendMode: "ctrlEnter", isStreaming: false, slashMenuOpen: true, slashQuery: "copy", value: "/copy", displayedSlashCommands: [{ name: "copy", source: "builtin" }] }, "send"],
    ["mobile ignores Ctrl+Enter mode for plain Enter", {}, { enterSendMode: "ctrlEnter", isMobile: true }, "native"],
  ];
  for (const [name, keys, state, expected] of cases) {
    let action = "native";
    const handler = script.runInNewContext({
      Date: { now: () => 1000 },
      COMPOSITION_END_ENTER_GRACE_MS: 100,
      isMobile: false, isStreaming: true, enterSendMode: "enter",
      isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 },
      historyMenuOpen: false, inputHistory: ["previous"], historyActiveIndex: 0,
      slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [{}], slashActiveIndex: 0,
      atMenuOpen: false, atQuery: null, atMatches: [{}], atActiveIndex: 0,
      hashMenuOpen: false, hashQuery: null, hashMatches: [{}], hashActiveIndex: 0, setHashMenuOpen() {},
      onSteer() {}, onFollowUp() {},
      sendQueued(mode) { action = mode; }, handleSend() { action = "send"; },
      applySlashCommand() { action = "slash"; },
      submitsSlashCommandOnEnter, value: "", setSlashMenuOpen() {},
      applyAtCompletion() { action = "file"; },
      applyHistoryInput() { action = "history"; },
      ...state,
    });
    handler({
      key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault() { action = "prevented"; },
      ...keys,
    });
    assert.equal(action, expected, name);
  }
});

test("file mention arrows wrap around the match list", () => {
  const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findHandler(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleKeyDown") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findHandler);
  }
  const script = new Script(ts.transpileModule(findHandler(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);

  function move(key, atActiveIndex, length) {
    let next = null;
    const handler = script.runInNewContext({
      Date: { now: () => 1000 },
      COMPOSITION_END_ENTER_GRACE_MS: 100,
      isMobile: false, isStreaming: false, enterSendMode: "enter",
      isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 },
      historyMenuOpen: false, inputHistory: [], historyActiveIndex: 0,
      slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [], slashActiveIndex: 0,
      atMenuOpen: true, atQuery: {}, atMatches: Array.from({ length }, () => ({})), atActiveIndex,
      hashMenuOpen: false, hashQuery: null, hashMatches: Array.from({ length }, () => ({})), hashActiveIndex: 0, setHashMenuOpen() {}, applyHashCompletion() {},
      onSteer() {}, onFollowUp() {},
      sendQueued() {}, handleSend() {},
      applySlashCommand() {},
      isExactSlashCommand() { return false; }, value: "@file",
      setSlashMenuOpen() {}, setAtMenuOpen() {},
      applyAtCompletion() {},
      applyHistoryInput() {},
      cycleListIndex,
      setAtActiveIndex(update) {
        next = typeof update === "function" ? update(atActiveIndex) : update;
      },
    });
    handler({
      key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 0 },
      preventDefault() {},
    });
    return next;
  }

  assert.equal(move("ArrowDown", 0, 3), 1);
  assert.equal(move("ArrowDown", 2, 3), 0);
  assert.equal(move("ArrowUp", 0, 3), 2);
  assert.equal(move("ArrowUp", 1, 3), 0);
  assert.equal(move("ArrowDown", 0, 1), 0);
  assert.equal(move("ArrowDown", 0, 0), 0);
});

test("cycleListIndex wraps in both directions", () => {
  assert.equal(cycleListIndex(0, 3, 1), 1);
  assert.equal(cycleListIndex(2, 3, 1), 0);
  assert.equal(cycleListIndex(0, 3, -1), 2);
  assert.equal(cycleListIndex(1, 3, -1), 0);
  assert.equal(cycleListIndex(0, 1, 1), 0);
  assert.equal(cycleListIndex(4, 0, 1), 0);
  assert.equal(cycleListIndex(-1, 4, 1), 0);
});

test("streaming with an empty draft has one circular Stop and no competing send controls", () => {
  const html = renderWithI18n(React.createElement(ChatInput, {
    onSend() {}, onAbort() {}, onSteer() {}, onFollowUp() {}, isStreaming: true,
  }));
  assert.match(html, /data-action="stop"/);
  assert.equal((html.match(/aria-label="Stop agent"/g) || []).length, 1);
  assert.doesNotMatch(html, /composer-queue-button|composer-stop-button|Alt\+Enter/);
});

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { initialLocale: "en" },
      React.createElement(ModelErrorBanner, {
        error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Model error/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(
    renderToStaticMarkup(
      React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(ModelErrorBanner, { error: null })),
    ),
    "",
  );
});

test("renders enabledModels scope warnings", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { initialLocale: "en" },
      React.createElement(ModelScopeWarningBanner, {
        warnings: [
          { code: "no-match", pattern: "ghost-gateway/*", message: 'No models match pattern "ghost-gateway/*"' },
        ],
      }),
    ),
  );
  assert.match(html, /ghost-gateway/);
  assert.match(html, /Model scope warning/);
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { initialLocale: "en" },
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        modelError: "Invalid models.json schema",
        modelList: [],
        modelNames: {},
      }),
    ),
  );

  assert.match(html, />No models</);
  assert.match(html, /title="No available models"/);
});

test("renders the read-only tool preset as the active selection", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { initialLocale: "en" },
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onToolPresetChange() {},
        isStreaming: false,
        toolPreset: "read-only",
      }),
    ),
  );

  // The chip shows the preset's display name, not its settings id.
  assert.match(html, /title="Change tool preset: Read-only"/);
  assert.match(html, />Read-only<\/span>/);
});

test("renders the empty tool preset as Chat only", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { initialLocale: "en" },
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onToolPresetChange() {},
        isStreaming: false,
        toolPreset: "none",
      }),
    ),
  );

  assert.match(html, /title="Change tool preset: Chat only"/);
  assert.match(html, />Chat only<\/span>/);
});

test("renders the compact composer with the standard Send button and no session controls", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { initialLocale: "en" },
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        compact: true,
      }),
    ),
  );

  assert.match(html, /<textarea/);
  assert.match(html, /class="native-primary-button"[^>]*aria-label="Send"/);
  assert.match(html, />Send<\/button>/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.doesNotMatch(html, /type="file"|Attach image|Change tool preset/);
});

test("shows and locks the optimistic model while a switch is pending", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { initialLocale: "en" },
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
        modelList: [{ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
        modelSwitching: true,
      }),
    ),
  );

  assert.match(html, /title="Switching model"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, />DeepSeek V4 Flash</);
  assert.match(html, /animation:spin 0\.8s linear infinite/);
});

test("filters model options by name and id", () => {
  const options = [
    { provider: "ollama", modelId: "qwen3:latest", name: "Qwen 3" },
    { provider: "anthropic", modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { provider: "openai", modelId: "gpt-5.4", name: "GPT-5.4" },
  ];

  assert.deepEqual(filterModelOptions(options, "QWEN"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "claude-sonnet"), [options[1]]);
  assert.equal(filterModelOptions(options, "OpenAI").length, 0);
  assert.equal(filterModelOptions(options, "anthropic/claude").length, 0);
  assert.equal(filterModelOptions(options, "missing").length, 0);
  assert.equal(filterModelOptions(options, "  "), options);
});

test("renders the shared field model selector as a disabled gray control", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { initialLocale: "en" },
      React.createElement(ModelSelector, {
        options: [{ provider: "openai", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
        value: null,
        onChange() {},
        onClear() {},
        emptyLabel: "Parent default",
        ariaLabel: "Model override",
        disabled: true,
        variant: "field",
      }),
    ),
  );

  assert.match(html, /aria-label="Model override"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /background:var\(--bg-panel\)/);
  assert.match(html, />Parent default</);
});

test("caps an upward menu to the visible space above its anchor", () => {
  assert.equal(getUpwardMenuMaxHeight(343, 36), 299);
  assert.equal(getUpwardMenuMaxHeight(40, 36), 0);
  // Composer sitting under a 36px top bar with only ~160px of air: a 400px
  // file list would paint through the bar and hide the leading matches.
  assert.equal(getUpwardMenuMaxHeight(200, 36), 156);
  assert.ok(getUpwardMenuMaxHeight(200, 36) < 400);
});

test("an upward menu never opens underneath the app topbar (#63)", () => {
  const originals = { document: globalThis.document };
  const rect = (left, right, top, bottom) => ({ left, right, top, bottom });
  const element = {
    getBoundingClientRect: () => rect(100, 900, 500, 600),
  };
  const topbar = (left, right, top, bottom) => ({
    clientTop: 0,
    getBoundingClientRect: () => rect(left, right, top, bottom),
  });
  globalThis.document = {
    querySelectorAll: () => [topbar(0, 1280, 0, 52)],
  };
  try {
    // Horizontal overlap + topbar above the anchor: the boundary is its bottom.
    assert.equal(getTopbarBoundary(element), 52);
    // Topbar beside the anchor (no horizontal overlap): no boundary.
    globalThis.document = {
      querySelectorAll: () => [topbar(0, 80, 0, 52)],
    };
    assert.equal(getTopbarBoundary(element), 0);
    // Topbar drawn below the anchor must not shrink the menu.
    globalThis.document = {
      querySelectorAll: () => [topbar(0, 1280, 700, 752)],
    };
    assert.equal(getTopbarBoundary(element), 0);
    // No topbar in the tree (tests / detached use): no boundary.
    globalThis.document = { querySelectorAll: () => [] };
    assert.equal(getTopbarBoundary(element), 0);
  } finally {
    globalThis.document = originals.document;
  }
});

test("file mention menu applies the measured upward height cap", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const start = source.indexOf("{atMenuOpen && atQuery !== null && (() => {");
  assert.notEqual(start, -1);
  const block = source.slice(start, start + 4000);
  assert.match(block, /ref=\{atMenuRef\}/);
  assert.match(block, /min\(48vh, 400px, \$\{atMenuMaxHeight\}px\)/);
  assert.match(block, /flexDirection: "column"/);
  assert.match(block, /minHeight: 0/);
  assert.equal(block.includes("maxHeight: \"min(48vh, 400px)\""), false);
});

test("file mention menu remeasures when its layout container shifts the anchor", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const start = source.indexOf("function subscribeUpwardMenuMaxHeight");
  assert.notEqual(start, -1);
  const block = source.slice(start, start + 1800);
  assert.match(block, /const layoutContainer = parent\?\.parentElement;/);
  assert.match(block, /anchorObserver\?\.observe\(layoutContainer\)/);
});

test("compresses large images while preserving small images and GIFs", async () => {
  assert.equal(shouldCompressImageFile({ size: 1024 * 1024, type: "image/png" }), false);
  assert.equal(shouldCompressImageFile({ size: 1024 * 1024 + 1, type: "image/png" }), true);
  assert.equal(shouldCompressImageFile({ size: 2 * 1024 * 1024, type: "image/gif" }), false);

  const originals = {
    FileReader: globalThis.FileReader,
    createImageBitmap: globalThis.createImageBitmap,
    document: globalThis.document,
  };
  let bitmapCalls = 0;
  let closed = false;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }),
    toDataURL: () => "data:image/jpeg;base64,COMPRESSED",
  };

  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,ORIGINAL";
      this.onload();
    }
  };
  globalThis.createImageBitmap = async () => {
    bitmapCalls += 1;
    return { width: 2048, height: 1024, close() { closed = true; } };
  };
  globalThis.document = { createElement: () => canvas };

  try {
    assert.deepEqual(await compressImageFile({ size: 1024, type: "image/png" }), {
      data: "ORIGINAL",
      mimeType: "image/png",
    });
    assert.deepEqual(await compressImageFile({ size: 2 * 1024 * 1024, type: "image/png" }), {
      data: "COMPRESSED",
      mimeType: "image/jpeg",
    });
    assert.equal(bitmapCalls, 1);
    assert.equal(canvas.width, 1024);
    assert.equal(canvas.height, 512);
    assert.equal(closed, true);
  } finally {
    globalThis.FileReader = originals.FileReader;
    globalThis.createImageBitmap = originals.createImageBitmap;
    globalThis.document = originals.document;
  }
});

test("recognizes exact slash commands for one-Enter submission", () => {
  const builtin = { name: "copy", description: "", source: "builtin" };
  assert.equal(isExactSlashCommand("/copy", builtin), true);
  assert.equal(isExactSlashCommand("  /copy  ", builtin), true);
  assert.equal(isExactSlashCommand("/co", builtin), false);
  assert.equal(isExactSlashCommand("/copy extra", builtin), false);
  assert.equal(isExactSlashCommand("/copy", { ...builtin, source: "extension" }), false);
});

test("clears a completed built-in only while its submitted input is unchanged", () => {
  assert.equal(canClearBuiltinCommandInput("/copy", 0, "/copy"), true);
  assert.equal(canClearBuiltinCommandInput("new follow-up", 0, "/copy"), false);
  assert.equal(canClearBuiltinCommandInput("/copy", 1, "/copy"), false);
});

test("locks built-in command submission until it settles", async () => {
  const sourceText = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("ChatInput.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findCallback(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "runBuiltinCommand") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findCallback);
  }
  const callback = new Script(ts.transpileModule(findCallback(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext({
    attachedImages: [],
    attachedFilesRef: { current: [] }, composeMessageWithAttachedFiles,
    attachedImagesRef: { current: [] },
    builtinCommandPendingRef: { current: false },
    canClearBuiltinCommandInput,
    clearInput() {},
    onBuiltinCommand: async () => new Promise((resolve) => { callback.resolve = resolve; }),
    setBuiltinCommandPending(value) { callback.pendingStates.push(value); },
    valueRef: { current: "/reload" },
    // d5-19：runBuiltinCommand 的 15s 超时竞速需要 setTimeout（node 全局传入沙盒）。
    setTimeout,
    BUILTIN_COMMAND_TIMEOUT_MS: 15_000,
  });
  callback.pendingStates = [];

  const first = callback("/reload");
  assert.deepEqual(callback.pendingStates, [true]);
  assert.equal(await callback("/reload"), true);
  assert.deepEqual(callback.pendingStates, [true]);
  callback.resolve({ handled: true });
  assert.equal(await first, true);
  assert.deepEqual(callback.pendingStates, [true, false]);
  assert.match(sourceText, /<fieldset\s+disabled=\{builtinCommandPending\}\s+aria-busy=\{builtinCommandPending\}/);
});

test("keeps only read-only built-ins available while a run is active", () => {
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/copy"), true);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/session"), true);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/compact"), false);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/auto-compact"), false);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/reload"), false);
});

test("a bare /mcp reaches the built-in handler while a run is active", () => {
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/mcp"), true);
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/copy"), true);
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/compact"), false);
  // Subcommands act on the session's connections and are queued like any message.
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/mcp login docs"), false);
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/mcp:1"), false);
  // The built-in list itself is unchanged: /mcp is not one of the composer's built-ins.
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/mcp"), false);
});

test("Enter on pi's built-in /mcp submits it at once; other extension commands still complete first", () => {
  const builtinMcp = { name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" } };
  const otherMcp = { ...builtinMcp, sourceInfo: { ...builtinMcp.sourceInfo, path: "/ext/mcp.ts" } };
  const copy = { name: "copy", description: "", source: "builtin", availableWhileStreaming: true };
  const compact = { name: "compact", description: "", source: "builtin" };

  assert.equal(submitsSlashCommandOnEnter("/mcp", builtinMcp, false), true);
  assert.equal(submitsSlashCommandOnEnter("/mcp", builtinMcp, true), true);
  assert.equal(submitsSlashCommandOnEnter("/mc", builtinMcp, false), false);
  assert.equal(submitsSlashCommandOnEnter("/mcp", otherMcp, false), false);
  assert.equal(submitsSlashCommandOnEnter("/deploy", { ...otherMcp, name: "deploy" }, false), false);
  // The composer's built-ins keep their rule: typed in full, and while streaming only those allowed then.
  assert.equal(submitsSlashCommandOnEnter("/copy", copy, true), true);
  assert.equal(submitsSlashCommandOnEnter("/compact", compact, false), true);
  assert.equal(submitsSlashCommandOnEnter("/compact", compact, true), false);
  assert.equal(submitsSlashCommandOnEnter("/co", copy, false), false);

  const sourceText = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(sourceText, /if \(sendShortcut && submitsSlashCommandOnEnter\(value, selectedCommand, isStreaming\)\) \{/);
});

function chatInputCallback(name, context) {
  const sourceText = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("ChatInput.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findCallback(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findCallback);
  }
  return new Script(ts.transpileModule(findCallback(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext(context);
}

test("while a run streams, a bare /mcp opens Settings or is queued as before", async () => {
  const run = async (value, handled, { mode = "steer", images = [] } = {}) => {
    const calls = { builtin: [], prompts: [], cleared: 0 };
    const sendQueued = chatInputCallback("sendQueued", {
      value,
      attachedFilesRef: { current: [] }, composeMessageWithAttachedFiles,
      // d5-10：sendQueued 改读 attachedImagesRef；ref 与 state 同值时行为不变。
      attachedImagesRef: { current: images },
      attachedImages: images,
      // d5-9：窗口增量恢复纯函数。
      pendingTypedSuffix,
      // d5-9：发送基线快照读 valueRef（与 value 同值喂入，行为不变）。
      valueRef: { current: value },
      onAudioUnlock() {},
      clearInput() { calls.cleared += 1; },
      onBuiltinCommand: async () => ({ handled }),
      canRunBuiltinSlashCommandWhileStreaming,
      isBareMcpCommand,
      resolveSessionReferences: async (message) => message,
      sessionMentionTargetsRef: { current: new Map() },
      runBuiltinCommand: async (message) => { calls.builtin.push(message); return handled; },
      onPromptWithStreamingBehavior: (message, behavior, attached) => calls.prompts.push([message, behavior, attached?.length ?? 0]),
      onSteer() { throw new Error("slash messages are prompts"); },
      onFollowUp: (message, attached) => calls.prompts.push([message, "followUp", attached?.length ?? 0]),
    });
    sendQueued(mode);
    await new Promise((resolve) => setImmediate(resolve));
    return calls;
  };

  // Owned: Settings opened, nothing queued, the handler clears the input itself.
  assert.deepEqual(await run("/mcp", true), { builtin: ["/mcp"], prompts: [], cleared: 0 });
  // Another extension's /mcp: queued exactly as before.
  assert.deepEqual(await run("/mcp", false), { builtin: ["/mcp"], prompts: [["/mcp", "steer", 0]], cleared: 1 });
  assert.deepEqual(await run("/mcp", false, { mode: "followup" }), { builtin: ["/mcp"], prompts: [["/mcp", "followUp", 0]], cleared: 1 });
  // Subcommands and a /mcp with images never reach the handler.
  assert.deepEqual(await run("/mcp login docs", true), { builtin: [], prompts: [["/mcp login docs", "steer", 0]], cleared: 1 });
  assert.deepEqual(await run("/mcp", true, { images: [{}] }), { builtin: [], prompts: [["/mcp", "steer", 1]], cleared: 1 });
  // The composer's own built-ins are unchanged.
  assert.deepEqual(await run("/copy", true), { builtin: ["/copy"], prompts: [], cleared: 0 });
});

test("while a run streams, a streamable built-in the builtin layer rejects is queued, not dropped", async () => {
  const run = async (value, handled, { mode = "steer" } = {}) => {
    const calls = { builtin: [], prompts: [], cleared: 0 };
    const sendQueued = chatInputCallback("sendQueued", {
      value,
      attachedFilesRef: { current: [] }, composeMessageWithAttachedFiles,
      // d5-10：ref 形参适配（ref 与 state 同值时行为不变）。
      attachedImagesRef: { current: [] },
      attachedImages: [],
      // d5-9：handleSend/sendQueued 恢复窗口增量的纯函数（与实现在同文件，导入传入）。
      pendingTypedSuffix,
      // d5-9：发送基线快照读 valueRef（与 value 同值喂入，行为不变）。
      valueRef: { current: value },
      onAudioUnlock() {},
      clearInput() { calls.cleared += 1; },
      onBuiltinCommand: async () => ({ handled }),
      canRunBuiltinSlashCommandWhileStreaming,
      isBareMcpCommand,
      resolveSessionReferences: async (message) => message,
      sessionMentionTargetsRef: { current: new Map() },
      runBuiltinCommand: async (message) => { calls.builtin.push(message); return handled; },
      onPromptWithStreamingBehavior: (message, behavior, attached) => calls.prompts.push([message, behavior, attached?.length ?? 0]),
      onSteer() { throw new Error("slash messages are prompts"); },
      onFollowUp: (message, attached) => calls.prompts.push([message, "followUp", attached?.length ?? 0]),
    });
    sendQueued(mode);
    await new Promise((resolve) => setImmediate(resolve));
    return calls;
  };
  // /session and /copy are offered while streaming; when the builtin layer
  // does not own the call this round, they land in the queue like bare /mcp
  // instead of vanishing without any feedback.
  assert.deepEqual(await run("/session", true), { builtin: ["/session"], prompts: [], cleared: 0 });
  assert.deepEqual(await run("/session", false), { builtin: ["/session"], prompts: [["/session", "steer", 0]], cleared: 1 });
  assert.deepEqual(await run("/copy", false, { mode: "followup" }), { builtin: ["/copy"], prompts: [["/copy", "followUp", 0]], cleared: 1 });
});

test("handleSend lets a handled /mcp through while streaming and sends an unowned one when idle", async () => {
  const run = async (value, { isStreaming, handled }) => {
    const calls = { builtin: [], sent: [] };
    const handleSend = chatInputCallback("handleSend", {
      value,
      attachedFilesRef: { current: [] }, composeMessageWithAttachedFiles,
      // d5-10：ref 形参适配（ref 与 state 同值时行为不变）。
      attachedImagesRef: { current: [] },
      attachedImages: [],
      // d5-9：handleSend/sendQueued 恢复窗口增量的纯函数（与实现在同文件，导入传入）。
      pendingTypedSuffix,
      // d5-9：发送基线快照读 valueRef（与 value 同值喂入，行为不变）。
      valueRef: { current: value },
      onAudioUnlock() {},
      isStreaming,
      workspaceUnavailable: null,
      offersBuiltinSlashCommandWhileStreaming,
      resolveSessionReferences: async (message) => message,
      sessionMentionTargetsRef: { current: new Map() },
      runBuiltinCommand: async (message) => { calls.builtin.push(message); return handled; },
      clearInput() {},
      onSend: (message) => calls.sent.push(message),
      // 本用例只关心 /mcp 的路由，Agent Team armed 显式关掉，让发送的就是原文。
      agentTeamsEnabled: false,
      withAgentTeamRequest,
      shouldDisarmAgentTeam,
      disarmAgentTeam() { throw new Error("disarmed while nothing was armed"); },
    });
    await handleSend();
    return calls;
  };
  assert.deepEqual(await run("/mcp", { isStreaming: true, handled: true }), { builtin: ["/mcp"], sent: [] });
  assert.deepEqual(await run("/mcp", { isStreaming: false, handled: true }), { builtin: ["/mcp"], sent: [] });
  assert.deepEqual(await run("/mcp", { isStreaming: false, handled: false }), { builtin: ["/mcp"], sent: ["/mcp"] });
  // Streaming without steer handlers keeps any other message in the composer, as before.
  assert.deepEqual(await run("/mcp login", { isStreaming: true, handled: false }), { builtin: [], sent: [] });
});

test("restores text and base64 images when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "text", text: "Review this image @src/example.ts " },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ],
  };

  assert.equal(getUserMessageText(message), "Review this image @src/example.ts ");
  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/png" },
  ]);
});

test("restores legacy flat image entries when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "image", data: "AQID", mimeType: "image/jpeg" },
    ],
  };

  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/jpeg" },
  ]);
});

test("does not restore a historical message over a pending image attachment", () => {
  assert.equal(canRestoreUserMessage("", 0, 0), true);
  assert.equal(canRestoreUserMessage("", 1, 0), false);
  assert.equal(canRestoreUserMessage("", 0, 1), false);
  assert.equal(canRestoreUserMessage("draft", 0, 0), false);
});

test("restores a cleared submission using the queued React state", () => {
  let value = "failed submission";
  const updates = [
    () => "",
    (current) => mergeRestoredSubmissionText("failed submission", current),
  ];

  for (const update of updates) value = update(value);

  assert.equal(value, "failed submission");
  assert.equal(
    mergeRestoredSubmissionText("failed submission", "new draft"),
    "failed submission\n\nnew draft",
  );
  assert.equal(
    mergeRestoredSubmissionText("failed submission", "failed submission"),
    "failed submission\n\nfailed submission",
  );
});

test("keeps a failed first submission recoverable across a composer remount", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeRestoredSubmissionDraft(
    "failed submission",
    [image],
    "",
    [],
  );

  assert.deepEqual(restored, {
    value: "failed submission",
    images: [image],
  });
  assert.deepEqual(
    mergeRestoredSubmissionDraft("failed submission", [image], "new draft", []),
    {
      value: "failed submission\n\nnew draft",
      images: [image],
    },
  );
});

test("preserves duplicate image attachments when restoring a submission", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeRestoredSubmissionDraft("", [image, image], "", [image]);

  assert.deepEqual(restored.images, [image, image, image]);
});

test("moves a provisional new-session draft to the real session key", () => {
  const provisionalKey = "new:/tmp/rekey-test";
  const sessionKey = "session-rekey-test";
  clearDraft(provisionalKey);
  clearDraft(sessionKey);
  setDraft(provisionalKey, { value: "queued while preflight ran", images: [] });

  assert.deepEqual(rekeyDraft(provisionalKey, sessionKey), {
    value: "queued while preflight ran",
    images: [],
  });
  assert.equal(getDraft(provisionalKey), null);
  assert.deepEqual(getDraft(sessionKey), {
    value: "queued while preflight ran",
    images: [],
  });

  clearDraft(sessionKey);
});

test("rekey keeps a synchronously restored draft when React state is still empty", () => {
  const provisionalKey = "new:/tmp/rekey-race";
  const sessionKey = "session-rekey-race";
  clearDraft(provisionalKey);
  clearDraft(sessionKey);
  setDraft(provisionalKey, { value: "restored before state flush", images: [] });

  assert.deepEqual(
    rekeyDraft(provisionalKey, sessionKey, { value: "", images: [] }),
    { value: "restored before state flush", images: [] },
  );
  assert.equal(getDraft(provisionalKey), null);
  assert.deepEqual(getDraft(sessionKey), {
    value: "restored before state flush",
    images: [],
  });

  clearDraft(sessionKey);
});

test("renders compact errors above the input as a wrapping alert", () => {
  const error = "Compaction failed: OpenAI API error (403): <html>request forbidden</html>";
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { initialLocale: "en" },
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onCompact() {},
        isStreaming: false,
        compactError: error,
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Compaction failed: OpenAI API error/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
  assert.match(html, /white-space:pre-wrap/);
  assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
});

test("modelSupportsImageInput warns only when modality info is known and lacks image", () => {
  const modelList = [
    { id: "text-only", name: "Text Only", provider: "ollama", input: ["text"] },
    { id: "vision", name: "Vision", provider: "anthropic", input: ["text", "image"] },
    { id: "unknown", name: "Unknown", provider: "custom", input: undefined },
  ];

  assert.equal(modelSupportsImageInput({ provider: "ollama", modelId: "text-only" }, modelList), false);
  assert.equal(modelSupportsImageInput({ provider: "anthropic", modelId: "vision" }, modelList), true);
  // Unknown modality info never blocks the user.
  assert.equal(modelSupportsImageInput({ provider: "custom", modelId: "unknown" }, modelList), true);
  // Model missing from the list is treated as unknown.
  assert.equal(modelSupportsImageInput({ provider: "x", modelId: "missing" }, modelList), true);
  assert.equal(modelSupportsImageInput(null, modelList), true);
  assert.equal(modelSupportsImageInput({ provider: "ollama", modelId: "text-only" }, undefined), true);
});

test("renders image warnings for known text-only defaults without an explicit model selection", () => {
  const draftKey = "new:/tmp/image-warning-default";
  const modelList = [
    { id: "text-only", name: "Text Only", provider: "custom", input: ["text"] },
    { id: "vision", name: "Vision", provider: "custom", input: ["text", "image"] },
    { id: "unknown", name: "Unknown", provider: "custom" },
  ];
  setDraft(draftKey, {
    value: "Describe this image",
    images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
  });

  try {
    for (const [modelId, warningExpected] of [["text-only", true], ["vision", false], ["unknown", false], [null, false]]) {
      const html = renderToStaticMarkup(
        React.createElement(
          I18nProvider,
          { initialLocale: "en" },
          React.createElement(ChatInput, {
            onSend() {},
            onAbort() {},
            isStreaming: false,
            isAutoModelSelection: true,
            model: modelId ? { provider: "custom", modelId } : null,
            modelList,
            draftKey,
          }),
        ),
      );

      assert.match(html, /<img/);
      assert.equal(html.includes("Images may not be sent"), warningExpected, `default model: ${modelId}`);
      if (warningExpected) {
        assert.match(html, /The selected model \(Text Only\) does not support image input/);
        assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
      }
    }
  } finally {
    clearDraft(draftKey);
  }
});

test("handleSend sends exactly once and routes builtin commands through the pending guard", async () => {
  const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findHandler(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleSend") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findHandler);
  }
  const script = new Script(ts.transpileModule(findHandler(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);

  function run({ value = "hello", attachedImages = [], builtinHandled = false, resolved = null, workspaceUnavailable = null, agentTeamsEnabled = false }) {
    let sends = 0;
    let cleared = 0;
    let builtinCalls = 0;
    let disarms = 0;
    const handler = script.runInNewContext({
      value, attachedImages, isStreaming: false, workspaceUnavailable,
      attachedFilesRef: { current: [] }, composeMessageWithAttachedFiles,
      // d5-10：ref 形参适配（ref 与 state 同值时行为不变）。
      attachedImagesRef: { current: attachedImages },
      pendingTypedSuffix,
      // d5-9：发送基线快照读 valueRef（与 value 同值喂入，行为不变）。
      valueRef: { current: value },
      onAudioUnlock() {},
      runBuiltinCommand: async () => {
        builtinCalls += 1;
        return builtinHandled;
      },
      resolveSessionReferences: async (msg) => resolved ?? msg,
      sessionMentionTargetsRef: { current: [] },
      onSend(message, images) { sends += 1; handler.sent = { message, images }; },
      clearInput() { cleared += 1; },
      agentTeamsEnabled,
      withAgentTeamRequest,
      shouldDisarmAgentTeam,
      disarmAgentTeam() { disarms += 1; },
    });
    return handler().then(() => ({ sends, cleared, builtinCalls, disarms, sent: handler.sent }));
  }

  // Plain message: one send of the resolved text, one clear, no double-send.
  const plain = await run({ value: "  hello " });
  assert.equal(plain.sends, 1);
  assert.equal(plain.sent.message, "hello");
  assert.equal(plain.cleared, 1);

  // Session mentions resolve before sending; the raw text is never sent.
  const mentioned = await run({ value: "see #abc123", resolved: "see /path/to/abc123.jsonl" });
  assert.equal(mentioned.sends, 1);
  assert.equal(mentioned.sent.message, "see /path/to/abc123.jsonl");

  // Handled builtin command stops before onSend; unhandled falls through.
  const builtin = await run({ value: "/compact", builtinHandled: true });
  assert.equal(builtin.builtinCalls, 1);
  assert.equal(builtin.sends, 0);
  assert.equal(builtin.cleared, 0);
  const passthrough = await run({ value: "/unknown", builtinHandled: false });
  assert.equal(passthrough.sends, 1);

  // A deleted workspace blocks the prompt and keeps the draft; local commands still run.
  const gone = { cwd: "/gone", availability: "missing" };
  const blocked = await run({ value: "hello", workspaceUnavailable: gone });
  assert.equal(blocked.sends, 0);
  assert.equal(blocked.cleared, 0);
  const local = await run({ value: "/copy", builtinHandled: true, workspaceUnavailable: gone });
  assert.equal(local.builtinCalls, 1);

  // Agent Team armed：关着发原文且不动开关；开着在原文前加团队指令块（原文在块之后），
  // 发完即复位（对齐 cc-haha 发送调用之后 disarmAgentTeam()）。
  const teamOff = await run({ value: "拆一下这活", agentTeamsEnabled: false });
  assert.equal(teamOff.sent.message, "拆一下这活");
  assert.equal(teamOff.disarms, 0, "nothing was armed");
  const teamOn = await run({ value: "拆一下这活", agentTeamsEnabled: true });
  assert.equal(teamOn.sent.message, withAgentTeamRequest("拆一下这活"));
  assert.ok(teamOn.sent.message.endsWith("拆一下这活"), "用户原文应完整保留在块之后");
  assert.equal(teamOn.disarms, 1, "a sent team message disarms the next one");
  // 命令类消息不被包装，也就不消耗这次 armed（isAgentTeamCommand 的豁免）。
  const command = await run({ value: "/compact", agentTeamsEnabled: true, builtinHandled: false });
  assert.equal(command.sent.message, "/compact");
  assert.equal(command.disarms, 0, "commands leave the arming for the next real prompt");
});

/**
 * 抽出 `useImperativeHandle(ref, () => ({...}))` 的工厂并调用它，得到 composer 的命令式句柄
 * （insertIfEmpty / replaceMessage / rekeyDraft / restoreSubmission …）。
 * 与 chatInputCallback 一样走 vm：句柄里的自由变量由 `context` 提供，测试因此能只装配
 * replaceMessage 真正用到的那几个依赖。
 */
function chatInputHandle(context) {
  const sourceText = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("ChatInput.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findFactory(node) {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "useImperativeHandle") {
      return node.arguments[1];
    }
    return ts.forEachChild(node, findFactory);
  }
  const factory = new Script(ts.transpileModule(findFactory(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext(context);
  return factory();
}

/**
 * 抽出 armed chip 的 ✕ 处理器（`<AgentTeamChip onRemove={() => disarmAgentTeam(draftKey)} />`），
 * 让「点 ✕」走真实的 JSX 接线，而不是测试里另写一份等价调用。
 */
function agentTeamChipRemoveHandler(context) {
  const sourceText = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("ChatInput.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findChip(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "AgentTeamChip") {
      const attr = node.attributes.properties.find(
        (property) => ts.isJsxAttribute(property) && property.name.getText(source) === "onRemove",
      );
      if (attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer)) {
        return attr.initializer.expression;
      }
    }
    return ts.forEachChild(node, findChip);
  }
  return new Script(ts.transpileModule(findChip(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext(context);
}

/**
 * A5 回归（V1）：编辑重发路径的 armed 接线。
 *
 * 判据是真实的 `userMessageRequestsAgentTeam()`（ChatInput.tsx）→ `hasAgentTeamRequest()`
 * （lib/agent-team-request.ts）→ `armAgentTeam()`（hooks/useAgentTeamsEnabled.ts），
 * 不是「界面上有个 chip」。三个用例：
 *   1) 编辑一条曾带 team 块的消息 → 重新 armed；
 *   2) 编辑普通消息 → 不误 arm；
 *   3) 编辑态点 chip 的 ✕ → armed 回 false。
 */
test("editing a message that carried an Agent Team block re-arms the next send (A5)", () => {
  disarmAgentTeam();

  const armedKeys = [];
  const setValueCalls = [];
  const handle = chatInputHandle({
    textareaRef: { current: null },
    value: "",
    canRestoreUserMessage,
    attachedImagesRef: { current: [] },
    attachedFilesRef: { current: [] },
    pendingImageCountRef: { current: 0 },
    splitMessageForComposer,
    getUserMessageText,
    getUserMessageDraftImages,
    draftImagesToAttachedImages: (images) => images.map((image) => ({ ...image, previewUrl: "" })),
    userMessageRequestsAgentTeam,
    // 真实状态层：arm 之外顺带记录会话键，验证接线传的是当前草稿键。
    armAgentTeam(key) { armedKeys.push(key); armAgentTeam(key); },
    draftKeyRef: { current: "session-a5-edit" },
    valueRef: { current: "" },
    setAttachedFiles() {},
    setValue(next) { setValueCalls.push(next); },
    setAtQuery() {},
    setHashQuery() {},
    setHistoryMenuOpen() {},
    setAttachedImages() {},
    revokeImagePreview() {},
    requestAnimationFrame() {},
  });

  // ① 曾请求团队的消息：真实判定为 true，编辑后重新 armed。
  const teamMessage = { role: "user", content: withAgentTeamRequest("拆一下这活") };
  assert.equal(hasAgentTeamRequest(teamMessage.content), true, "the fixture really carries the block");
  assert.equal(userMessageRequestsAgentTeam(teamMessage), true);
  assert.equal(handle.replaceMessage(teamMessage), true);
  assert.deepEqual(armedKeys, ["session-a5-edit"], "re-arms under the composer's own draft key");
  assert.equal(isAgentTeamsArmed(), true, "the next send will re-wrap with the team block");
  // 回填的是剥掉块之后的用户原文（否则重发会套两层）。
  assert.deepEqual(setValueCalls, ["拆一下这活"]);

  // ② 普通消息：不误 arm。
  disarmAgentTeam();
  armedKeys.length = 0;
  const plainMessage = { role: "user", content: "普通消息" };
  assert.equal(hasAgentTeamRequest(plainMessage.content), false);
  assert.equal(userMessageRequestsAgentTeam(plainMessage), false);
  assert.equal(handle.replaceMessage(plainMessage), true);
  assert.deepEqual(armedKeys, [], "a plain message must not arm anything");
  assert.equal(isAgentTeamsArmed(), false);

  // ③ 编辑态点 ✕：走 ChatInput 里真实的 onRemove 接线，armed 回 false。
  handle.replaceMessage(teamMessage);
  assert.equal(isAgentTeamsArmed(), true);
  const removeHandler = agentTeamChipRemoveHandler({ disarmAgentTeam, draftKey: "session-a5-edit" });
  removeHandler();
  assert.equal(isAgentTeamsArmed(), false, "the ✕ clears the arming for this edit");

  disarmAgentTeam();
});

test("a missing workspace replaces the model error and disables Send", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(source, /workspaceUnavailable\s*\?\s*<WorkspaceUnavailableBanner[\s\S]*?:\s*<ModelErrorBanner error=\{modelError\} \/>/);
  assert.match(source, /const canSend = canQueueStreamingMessage && !workspaceUnavailable;/);
  assert.match(source, /disabled=\{!showStop && \(!canSend/);
});

test("chat-only composer keeps shell, file and session mentions out of the input", () => {
  const html = renderWithI18n(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      chatOnly: true,
      cwd: "/repo",
      toolPreset: "none",
      onThinkingLevelChange() {},
    }),
  );

  assert.match(html, /accept="image\/\*"/);
  assert.match(html, /aria-label="Attach image"/);
  assert.match(html, /Chat · \/ commands · images &amp; text files/);
  assert.doesNotMatch(html, /@ files/);
  assert.doesNotMatch(html, /# sessions/);
  assert.doesNotMatch(html, />Shell</);

  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(source, /const bashMode = !chatOnly && attachedImages\.length === 0/);
  assert.match(source, /if \(chatOnly \|\| !cwd\) \{\s*setAtQuery\(null\)/);
  assert.match(source, /useSessionMentionPalette\(\{ cwd: chatOnly \? null : cwd/);
  // The chat's rows (what it can do, its folder, the computer switch) come from ChatAccessRows.
  assert.match(source, /\{chatOnly && \([\s\S]*?<ChatAccessRows[\s\S]*?access=\{chatAccess\}/);
  const rows = readFileSync(new URL("./ChatAccessRows.tsx", import.meta.url), "utf8");
  assert.match(rows, /t\("chat\.chatOnlyDescription"\)/);
});

test("only the chat composer offers saving a default model or reasoning level", () => {
  const chatInputSource = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const agentsConfigSource = readFileSync(new URL("./AgentsConfig.tsx", import.meta.url), "utf8");
  assert.match(chatInputSource, /<ModelSelector[\s\S]*?defaultValue=\{defaultModel\}[\s\S]*?onSetDefault=\{onSetDefaultModel\}/);
  // "auto" means "use the default", so it never gets a star of its own.
  assert.match(chatInputSource, /star=\{onSetDefaultThinkingLevel && lvl !== "auto"/);
  // A subagent profile's model is not the default for new chats.
  assert.doesNotMatch(agentsConfigSource, /onSetDefault/);
});

test("selector rows expose a plain default star separate from the selected option", async () => {
  const { SelectorRow } = await jiti.import("./SelectorRow.tsx");
  const star = (isDefault) => ({ isDefault, saveLabel: "Save as default", defaultLabel: "Default", onSave: () => {} });
  const row = (props) => renderToStaticMarkup(React.createElement(SelectorRow, {
    active: false,
    onSelect: () => {},
    ...props,
  }, "Alpha"));

  const savable = row({ star: star(false) });
  assert.match(savable, /role="option"/);
  assert.match(savable, /aria-label="Save as default"/);
  // The unfilled star stays available to pointer, keyboard and touch input.
  assert.match(savable, /class="app-default-star"/);
  assert.doesNotMatch(savable, /opacity:0|tabindex="-1"|box-shadow/);
  assert.match(savable, /padding:7px 36px 7px 12px/);
  assert.doesNotMatch(savable, /aria-label="Default"/);

  // The default row shows a static marker in the same spot and no button.
  const saved = row({ star: star(true) });
  assert.match(saved, /role="img" aria-label="Default"/);
  assert.match(saved, /fill="currentColor"/);
  assert.doesNotMatch(saved, /Save as default/);

  const plain = row({});
  assert.doesNotMatch(plain, /Save as default|aria-label="Default"/);
  assert.match(plain, /padding:7px 12px/);
  // Rows without a star still line up with starred ones in the same menu.
  assert.match(row({ gutter: true }), /padding:7px 36px 7px 12px/);

  const active = row({ active: true });
  assert.match(active, /aria-selected="true"/);
  assert.match(active, /data-selected="true"/);
  assert.doesNotMatch(active, /polyline/);
  assert.doesNotMatch(active, /border-left/);
});

// ── d5-11/d5-10（28f03fc 的 commit message 声称的测试当时未落地，本次补齐）──────────
// resolveImageLanding 是在途图片的落点决策纯函数：压缩完成时用户可能已卸载、已清空
// 或已切到另一个会话。三分支各有明确的副作用语义（见 ChatInput.processImageFiles）。
test("resolveImageLanding：已卸载或在途清空都只回收，不落任何状态", () => {
  // 已卸载（组件 unmount 后压缩才完成）：只回收 blob，绝不能写草稿或 state。
  assert.deepEqual(
    resolveImageLanding({ disposed: true, cleared: false, startedIn: "s1", currentDraftKey: "s1" }),
    { action: "discard" },
  );
  // 已清空（clearInput bump 了 clearVersion）：同上——发送后在途图不许复活进已清空的输入框。
  assert.deepEqual(
    resolveImageLanding({ disposed: false, cleared: true, startedIn: "s1", currentDraftKey: "s1" }),
    { action: "discard" },
  );
});

test("resolveImageLanding：跨会话落地写回来源会话草稿", () => {
  // 粘贴在 s1、压缩完成时已切到 s2：图片属于 s1，回 s1 时经 draft 重建（base64）。
  assert.deepEqual(
    resolveImageLanding({ disposed: false, cleared: false, startedIn: "s1", currentDraftKey: "s2" }),
    { action: "draft", draftKey: "s1" },
  );
  // startedIn 为 null（来源会话无草稿键）且未切换：正常追加。
  assert.deepEqual(
    resolveImageLanding({ disposed: false, cleared: false, startedIn: null, currentDraftKey: null }),
    { action: "append" },
  );
  // 同会话（startedIn === currentDraftKey）：正常追加。
  assert.deepEqual(
    resolveImageLanding({ disposed: false, cleared: false, startedIn: "s1", currentDraftKey: "s1" }),
    { action: "append" },
  );
});

test("resolveImageLanding：清空优先于跨会话（先切会话再清空时只回收）", () => {
  // 粘贴在 s1 → 清空（bump）→ 压缩完成时又切到 s2：清空意图覆盖一切，只回收。
  assert.deepEqual(
    resolveImageLanding({ disposed: false, cleared: true, startedIn: "s1", currentDraftKey: "s2" }),
    { action: "discard" },
  );
});

// clearInput 的 bump（d5-10）：发送/清空必须使在途压缩的 clearVersion 快照失效——
// 守卫为源码正则（clearInput 在 forwardRef 闭包内，无法直接抽测），断言两处协同：
// ① clearInput 第一行 bump；② processImageFiles 读取快照后与最新值比对。
test("clearInput 使在途图片快照失效（bump attachmentClearVersionRef）", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const clearInputStart = source.indexOf("const clearInput = useCallback(() => {");
  assert.ok(clearInputStart !== -1, "clearInput 定义存在");
  const clearInputBody = source.slice(clearInputStart, clearInputStart + 400);
  assert.match(clearInputBody, /attachmentClearVersionRef\.current \+= 1;/, "clearInput 必须 bump clearVersion");
  const processStart = source.indexOf("const startedIn: string | null = draftKeyRef.current ?? null;");
  assert.ok(processStart !== -1, "processImageFiles 必须捕获 startedIn 快照");
  const processBody = source.slice(processStart, processStart + 1200);
  assert.match(processBody, /clearVersion !== attachmentClearVersionRef\.current/, "processImageFiles 必须比对 clearVersion");
});

// ── d5-9：发送 await 窗口内新增键入不蒸发 ─────────────────────────────────
test("pendingTypedSuffix：仅尾部追加可归位，中间删改保守丢弃", async () => {
  const { pendingTypedSuffix } = await jiti.import("./ChatInput.tsx");
  // await 窗口内只在基线尾部追加：恢复后缀。
  assert.equal(pendingTypedSuffix("hello", "hello world"), " world");
  // 窗口内没打字：空。
  assert.equal(pendingTypedSuffix("hello", "hello"), "");
  // 窗口内删改了已发送部分（前缀失配）：无法安全归位，丢弃。
  assert.equal(pendingTypedSuffix("hello", "help world"), "");
  // 窗口内把文本删短：丢弃。
  assert.equal(pendingTypedSuffix("hello world", "hello"), "");
  // 空基线（/mcp 之类清空发送后继续键入）：全部属于新增，整体恢复。
  assert.equal(pendingTypedSuffix("", "next"), "next");
});

test("handleSend/sendQueued 接线：捕获基线 + clearInput 前比对恢复", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const handleStart = source.indexOf("const handleSend = useCallback(async () => {");
  const handleBody = source.slice(handleStart, source.indexOf("const slashQuery", handleStart));
  assert.match(handleBody, /const sendBaseline = valueRef\.current;/, "handleSend 必须捕获发送基线");
  assert.match(handleBody, /pendingTypedSuffix\(sendBaseline, valueRef\.current\)/, "clearInput 前必须比对窗口增量");
  const queuedStart = source.indexOf("const sendQueued = useCallback(async (mode: \"steer\" | \"followup\") => {");
  const queuedBody = source.slice(queuedStart, queuedStart + 2200);
  assert.match(queuedBody, /const sendBaseline = valueRef\.current;/, "sendQueued 必须捕获发送基线");
  assert.match(queuedBody, /pendingTypedSuffix\(sendBaseline, valueRef\.current\)/);
});

// ── d5-19：内置命令挂起不再永久冻结 composer ─────────────────────────────
test("runBuiltinCommand 有超时上限：超时按未处理返回且不 clearInput", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const runBuiltinCommand = useCallback(async (msg: string): Promise<boolean> => {");
  assert.ok(start !== -1, "runBuiltinCommand 存在");
  const body = source.slice(start, source.indexOf("const handleSend", start));
  assert.match(body, /Promise\.race\(\[\s*onBuiltinCommand\(msg\),/, "必须对 onBuiltinCommand 加超时竞速");
  assert.match(body, /BUILTIN_COMMAND_TIMEOUT_MS/);
  assert.match(source, /const BUILTIN_COMMAND_TIMEOUT_MS = 15_000;/, "超时常量 15s");
  // 超时分支：race 返回 null → 与 {handled:false} 同走 return false，不触发 clearInput。
  assert.match(body, /if \(!result \|\| !result\.handled\) return false;/);
  const raceToClear = body.slice(body.indexOf("if (!result || !result.handled) return false;"), body.indexOf("if (!result || !result.handled) return false;") + 260);
  assert.ok(!/clearInput\(\)/.test(raceToClear.slice(0, raceToClear.indexOf("if (!result.error"))), "超时路径不得清空输入");
});
