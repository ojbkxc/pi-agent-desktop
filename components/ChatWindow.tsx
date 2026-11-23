"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { useCallback, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { UnavailableWorkspaceNotice } from "@/lib/workspace-availability";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, BlockingExtensionUiRequest, ExtensionUiRequest, LeafChangeOptions, SessionInfo, SessionTreeNode, SessionWorkspaceKind, ToolResultMessage, UserMessage } from "@/lib/types";
import { normalizeCustomPanelLines } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { countToolCallBlocks, getAssistantErrorMessage, getDisplayableAssistantBlocks, hasAssistantAnswer, isAssistantTruncated, isMessageGroupAnchor, splitFinalAssistantBlocks } from "@/lib/message-display";
import { buildComposerHistory } from "@/lib/composer-history";
import { formatToolSummary, summarizeToolCalls, type ToolSummaryInput, type ToolSummarySegment } from "@/lib/tool-groups";
import { ConversationFind } from "./ConversationFind";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import { formatTurnDuration, getTurnDurationMs } from "@/lib/turn-duration";
import { buildQuotedSelection } from "@/lib/quoted-selection";
import { MessageView } from "./MessageView";
import { useReportDesktopReady } from "./desktop";
import { MarkdownBody } from "./MarkdownBody";
import { ChatInput, getUserMessageDraftImages, getUserMessageText, type ChatInputHandle } from "./ChatInput";
import { AgentTeamPlanCard } from "./AgentTeams/AgentTeamPlanCard";
import { GoalStrip } from "./AgentTeams/GoalStrip";
import { SessionTitleStrip } from "./AgentTeams/SessionTitleStrip";
import { OutageBanner } from "./OutageBanner";
import { useTeamPlan } from "@/hooks/useTeamPlan";
import { agentTeamScopeKey } from "@/hooks/useAgentTeamsEnabled";
import { useGoalState } from "@/hooks/useGoalState";
import { isPlanCardVisible } from "@/lib/agent-teams-plan";
import { NewSessionWelcome } from "./NewSessionWelcome";
import { ConversationNavigator, type ConversationTurnLocation } from "./ConversationNavigator";
import { ExtensionWidgets } from "./ExtensionWidgets";
import { ExtensionStatusLine, formatExtensionStatusLine } from "./ExtensionStatusLine";
import { AnsiText } from "./AnsiText";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { phaseLabel } from "@/lib/chat-phase-label";
import { useAgentSession, type AgentEndInfo, type NoticeItem } from "@/hooks/useAgentSession";
import { selectHasStreamingContent, selectIsStreaming, selectStreamingMessage, useStreamingSelector } from "@/hooks/useStreamingSelector";
import type { StreamingStore } from "@/lib/streaming-message";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useScrollbarVisibility } from "@/hooks/useScrollbarVisibility";
import { useArtifactPublisher } from "@/hooks/useArtifactPublisher";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { importDroppedProjectFiles, partitionChatDroppedFiles } from "@/lib/chat-file-drop";
import { formatAttachmentSize } from "@/lib/chat-attachments";
import type { ToolEntry } from "@/lib/tool-presets";
import type { SettingsSection } from "@/lib/settings-navigation";
import { findChatScrollAnchor, type ChatScrollPosition } from "@/lib/chat-scroll-position";
import {
  captureScrollDistance,
  getPromptAnchorSpacerHeight,
  getVisibleRenderWindow,
  isScrollAtTail,
  restoreScrollTop,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";
import { sessionVisibleCounts } from "@/lib/scroll-memory";
import { isImeComposing } from "@/lib/ime";
import { useChatAccess } from "@/hooks/useChatAccess";
import { ChatShellPrompt } from "./ChatShellPrompt";
import { StreamingRateLine } from "./StreamingRateLine";
import { lastTurnHitChatShellBlock } from "@/lib/chat-shell-block";
import { assignMessageKeys, createMessageKeyTracker } from "@/lib/message-keys";

interface Props {
  session: SessionInfo | null;
  workspaceKind?: SessionWorkspaceKind;
  searchTarget?: { sessionId: string; entryId: string; blockIndex?: number } | null;
  onSearchTargetHandled?: (target: { sessionId: string; entryId: string }) => void;
  initialScrollPosition?: ChatScrollPosition | null;
  onScrollPositionChange?: (sessionId: string, position: ChatScrollPosition) => void;
  sessionRunning?: boolean;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  onAgentEnd?: (end: AgentEndInfo) => void;
  /** 标题条就地改名成功后刷新上层列表/选中会话；缺省时标题条只读。 */
  onSessionRenamed?: (id: string, name: string) => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  /** The cwd is known to be gone or unusable; the composer explains it and blocks new runs. */
  workspaceUnavailable?: UnavailableWorkspaceNotice | null;
  onRecheckWorkspace?: () => void;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null, options?: LeafChangeOptions) => void, locked: boolean) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  onSystemInfoLoaderChange?: (
    loader: ((kind: "system" | "tools" | "mcp") => Promise<void>) | null,
  ) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  /**
   * 当前会话所属团队的头部横幅（对齐 cc-haha：团队条与目标条相邻、都在消息列上方，
   * 是一整宽的横幅，不挤在应用顶栏）。由 AppShell 传组件进来，ChatWindow 不自己拉数据。
   * 该会话没有团队时传 null，不占位。
   */
  teamStrip?: React.ReactNode;
  /** Opens Settings on a section: a bare `/mcp` that pi's built-in MCP extension owns opens Settings › MCP. */
  onOpenSettings?: (section: SettingsSection) => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onSelectProject?: () => void;
  projectOptions?: string[];
  onProjectChange?: (projectRoot: string) => void;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** Fired after non-image drops are copied into the session cwd (so the explorer can refresh). */
  onProjectFilesImported?: () => void;
  /** Open the provider/auth configuration modal (offered by the scope-warning banner). */
  onOpenModelsConfig?: () => void;
  onOpenSession?: (sessionId: string) => void;
  onAskInNewChat?: (prompt: string, sourceSessionId: string, sourceEntryId: string) => Promise<void>;
  quoteSelectionEnabled?: boolean;
  conversationNavigatorEnabled?: boolean;
  initialPrompt?: string;
  onInitialPromptConsumed?: () => void;
  /** Completion sound state + controls, owned by AppShell so tasks finishing in
   *  a non-active workspace can still ring. */
  soundEnabled?: boolean;
  playDoneSound?: () => void;
  unlockAudio?: () => void;
}
// The chat-minimap gutter was removed with the fork's ChatMinimap deletion;
// the overlay keeps the name with zero width so the toast column spans full width.
const CHAT_MINIMAP_WIDTH = 0;
const CHAT_COLUMN_PADDING = 16;

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return getFinalSplit(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function getAssistantPreviewText(message: AgentMessage): string | null {
  if (message.role !== "assistant") return null;
  const text = getFinalSplit(message as AssistantMessage).answerBlocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

interface FinalSplitEntry {
  processBlocks: AssistantContentBlock[];
  answerBlocks: AssistantContentBlock[];
  /** The final assistant entry's process prefix, as rendered inside ProcessDetailsGroup. */
  processMessage: AssistantMessage;
  /** The final answer bubble; also kept for error/truncation notices without answer text. */
  answerMessage: AssistantMessage | null;
}

// Message objects are immutable (any change produces a new object), so the
// split/derived messages can be cached per object. Without this, every render
// hands MessageView freshly-created message objects, defeating its memo and
// re-running markdown + highlighting for already-finished answers on each
// streaming delta.
const finalSplitCache = new WeakMap<AssistantMessage, FinalSplitEntry>();

export function getFinalSplit(message: AssistantMessage): FinalSplitEntry {
  let cached = finalSplitCache.get(message);
  if (!cached) {
    const { processBlocks, answerBlocks } = splitFinalAssistantBlocks(message);
    const answerMessage = answerBlocks.length > 0 || getAssistantErrorMessage(message) || isAssistantTruncated(message)
      ? withAssistantBlocks(message, answerBlocks)
      : null;
    const processEnd = message.content.indexOf(answerBlocks[0]);
    cached = {
      processBlocks,
      answerBlocks,
      // Keep the original prefix so deferred thinking retains its stored block indices.
      processMessage: withAssistantBlocks(message, message.content.slice(0, processEnd < 0 ? undefined : processEnd), { omitUsage: Boolean(answerMessage) }),
      answerMessage,
    };
    finalSplitCache.set(message, cached);
  }
  return cached;
}

interface TurnWrittenFilesEntry {
  turnMessages: AgentMessage[];
  toolResults: Map<string, ToolResultMessage>;
  cwd: string | undefined;
  files: WrittenFile[];
}

// Keyed by the turn's final assistant message; reused while the turn's
// messages, tool results and cwd are unchanged, and while the derived list is
// equal, so MessageView's writtenFiles identity check holds across renders.
const turnWrittenFilesCache = new WeakMap<AssistantMessage, TurnWrittenFilesEntry>();

export function getTurnWrittenFiles(finalAssistant: AssistantMessage, turnMessages: AgentMessage[], toolResults: Map<string, ToolResultMessage>, cwd: string | undefined): WrittenFile[] {
  const cached = turnWrittenFilesCache.get(finalAssistant);
  if (cached && cached.toolResults === toolResults && cached.cwd === cwd
    && cached.turnMessages.length === turnMessages.length
    && cached.turnMessages.every((message, i) => message === turnMessages[i])) {
    return cached.files;
  }
  const turnContent: AssistantContentBlock[] = [];
  for (const message of turnMessages) {
    if (message.role === "assistant") turnContent.push(...((message as AssistantMessage).content ?? []));
  }
  let files = extractTurnWrittenFiles(turnContent, toolResults, cwd);
  if (cached && JSON.stringify(cached.files) === JSON.stringify(files)) files = cached.files;
  turnWrittenFilesCache.set(finalAssistant, { turnMessages, toolResults, cwd, files });
  return files;
}

function ProcessDetailsGroup({ messageCount, toolCallCount, toolSegments, durationMs, defaultExpanded = false, reveal = false, children, t }: { messageCount: number; toolCallCount: number; toolSegments?: readonly ToolSummarySegment[]; durationMs?: number; defaultExpanded?: boolean; reveal?: boolean; children: ReactNode; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  useLayoutEffect(() => {
    if (reveal) setExpanded(true);
  }, [reveal]);
  // cc-haha's summary is a verb phrase ("读取 2 个文件、运行 1 条命令"), not a
  // message/tool count. Fall back to the counts when nothing has a verb.
  const toolSummary = formatToolSummary(toolSegments ?? [], t);
  const parts = toolSummary
    ? [toolSummary]
    : [t("chat.processDetails"), `${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`];
  if (!toolSummary && toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);
  if (durationMs !== undefined) parts.push(t("chat.turnDuration", { time: formatTurnDuration(durationMs) }));
  // The visible title is the verb summary alone (cc-haha's shape); the accessible
  // name keeps the group's identity first so screen readers — and the e2e suite —
  // can still find "Process details" now that the counters no longer lead it.
  const triggerLabel = toolSummary ? `${t("chat.processDetails")} · ${parts.join(" · ")}` : parts.join(" · ");

  return (
    <div className="process-details" style={{ marginBottom: 14 }}>
      <button
        className="process-details-trigger"
        type="button"
        aria-expanded={expanded || reveal}
        aria-label={triggerLabel}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: "var(--fs-caption)",
          textAlign: "left",
        }}
        title={expanded ? t("chat.collapseProcess") : t("chat.expandProcess")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform var(--dur-base) var(--ease-native)" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      {(expanded || reveal) && (
        <div style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function ChatWindow({ session, workspaceKind, searchTarget, onSearchTargetHandled, initialScrollPosition, onScrollPositionChange, sessionRunning, newSessionCwd, newSessionDraftKey, onAgentEnd, onSessionRenamed, onAttentionNeeded, onSessionCreated, onSessionForked, modelsRefreshKey, workspaceUnavailable, onRecheckWorkspace, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsChange, onSessionStatsPanelOpen, teamStrip, onOpenSettings, onOpenModelsConfig, onContextUsageChange, onOpenFile, onOpenSession, onAskInNewChat, onSelectProject, projectOptions, onProjectChange, onProjectFilesImported, quoteSelectionEnabled = true, conversationNavigatorEnabled = true, initialPrompt, onInitialPromptConsumed, soundEnabled = true, playDoneSound = () => {}, unlockAudio }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const chatOnly = workspaceKind === "chat" || session?.workspaceKind === "chat";
  const messageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const completionNotificationsEnabled = session?.relation?.kind !== "subagent";

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const extensionDialogShownRef = useRef(false);
  const wrappedOnAgentEnd = useCallback((end: AgentEndInfo) => {
    // A run someone stopped did not finish anything, and one whose subagents still work did not finish the task.
    if (completionNotificationsEnabled && soundEnabledRef.current && !end.aborted && !end.subagentsActive) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.(end);
  }, [completionNotificationsEnabled, onAgentEnd]);

  const initialScrollPositionRef = useRef(searchTarget ? null : initialScrollPosition ?? null);
  const [pendingScrollRestore, setPendingScrollRestore] = useState<Extract<ChatScrollPosition, { atBottom: false }> | null>(() => {
    const position = initialScrollPositionRef.current;
    return position && !position.atBottom ? position : null;
  });
  const [restoreAnchorReady, setRestoreAnchorReady] = useState(false);

  const {
    loading, error, messages, activeToolResults, entryIds, historyCursor, hasEarlierMessages, streamingStore,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    retryInfo, contextUsage, forkingEntryId, summarizationRetry, automation, handleSetAutomation, compactionLimits,
    isCompacting, compactError, compactNotice, compactResult, displayModel: displayModelValue, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices, extensionDialog, waitingExtensionDialogCount, extensionCustomUi, waitingExtensionCustomUiCount, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput, setNoticePaused,
    isAutoModelSelection,
    isAutoThinkingSelection,
    defaultModel,
    savedDefaultThinkingLevel,
    agentPhase,
    addNotice,
    isNew,
    editEntryId,
    showScrollToBottom,
    sessionIdRef, scrollContainerRef,
    lastUserMsgRef, promptAnchorActive,
    branchSummaryPending, handleAbortBranchSummary, routedModel,
    handleSend, handleAbort, handleAbortRetry, handleFork, handleEditContent, cancelEdit, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction, handleQueuedMessageAction,
    retryLoad,
    dismissModelScopeWarnings,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleChatAccessRebuilt, handleThinkingLevelChange, handleSetDefaultModel, handleSetDefaultThinkingLevel, loadSlashCommands, scrollUserMsgToTop,
    loadContext, activeLeafId, scrollToBottom, scrollToMessage,
  } = useAgentSession({
    session, sessionRunning, newSessionCwd, newSessionDraftKey, onAgentEnd: wrappedOnAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked,
    chatWorkspace: chatOnly,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsPanelOpen,
    onOpenSettings,
    deferInitialScroll: Boolean(pendingScrollRestore),
    onScrollPositionChange,
  });
  // Only whether a reply is streaming and has content yet: the chunks themselves
  // re-render StreamingReply alone.
  const isStreaming = useStreamingSelector(streamingStore, selectIsStreaming);
  const hasStreamingContent = useStreamingSelector(streamingStore, selectHasStreamingContent);
  const getStreamingMessage = useCallback(() => streamingStore.getState().streamingMessage, [streamingStore]);
  const sessionBusy = agentRunning || bashRunning;
  // The new session starts with the forked message in its composer, ready to send again or change.
  const forkFromMessage = useCallback((entryId: string, message: UserMessage) => {
    void handleFork(entryId, { value: getUserMessageText(message), images: getUserMessageDraftImages(message) });
  }, [handleFork]);
  // A chat's folder and whether it may use the computer; the server owns both.
  const chatAccess = useChatAccess(session?.id, chatOnly && Boolean(session) && !isNew, handleChatAccessRebuilt);
  const handleToggleChatUnlocked = useCallback((nextUnlocked: boolean) => {
    if (sessionBusy) {
      addNotice({ type: "error", message: t("chat.chatUnlockBusy") });
      return;
    }
    void chatAccess?.setUnlocked(nextUnlocked);
  }, [addNotice, chatAccess, sessionBusy, t]);
  // The model asked for a shell this chat does not have: offer the permission right here.
  const chatNeedsShell = Boolean(
    chatAccess?.state.available && !chatAccess.state.unlocked && !sessionBusy && lastTurnHitChatShellBlock(messages),
  );
  // The desktop window stays hidden until the conversation it opens on is
  // loaded (or its load failed and the error is what the user will see).
  useReportDesktopReady(!loading, "chat");
  const [quotedSelection, setQuotedSelection] = useState<{
    text: string;
    top: number;
    left: number;
    sourceEntryId?: string;
  } | null>(null);
  const [quoteInputOpen, setQuoteInputOpen] = useState(false);
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const quotePopoverRef = useRef<HTMLDivElement | null>(null);
  const quoteChatInputRef = useRef<ChatInputHandle | null>(null);
  const closeQuotedSelection = useCallback(() => {
    setQuotedSelection(null);
    setQuoteInputOpen(false);
    setQuoteError(null);
  }, []);

  useEffect(() => {
    if (!quoteSelectionEnabled) closeQuotedSelection();
  }, [quoteSelectionEnabled, closeQuotedSelection]);

  const captureQuotedSelection = useCallback(() => {
    if (!quoteSelectionEnabled || quoteInputOpen) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const root = messageContentRef.current;
    if (!selection || selection.isCollapsed || !range || !root || !root.contains(range.commonAncestorContainer)) {
      setQuotedSelection(null);
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      setQuotedSelection(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer as Element
      : range.commonAncestorContainer.parentElement;
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer as Element
      : range.startContainer.parentElement;
    const end = range.endContainer.nodeType === Node.ELEMENT_NODE
      ? range.endContainer as Element
      : range.endContainer.parentElement;
    const sourceEntryId = [ancestor, start, end]
      .map((element) => element?.closest<HTMLElement>("[data-message-role=\"assistant\"]")?.dataset.entryId)
      .find((entryId): entryId is string => Boolean(entryId));
    setQuotedSelection({
      text,
      top: Math.min(window.innerHeight - 44, rect.bottom + 8),
      left: Math.max(64, Math.min(window.innerWidth - 64, rect.left + rect.width / 2)),
      sourceEntryId,
    });
  }, [quoteSelectionEnabled, quoteInputOpen]);

  useEffect(() => {
    if (!quoteInputOpen || !quotedSelection) return;
    quoteChatInputRef.current?.insertIfEmpty(buildQuotedSelection(quotedSelection.text));
  }, [quoteInputOpen, quotedSelection]);

  useLayoutEffect(() => {
    const popover = quotePopoverRef.current;
    if (!popover || !quotedSelection) return;
    const viewport = window.visualViewport;
    const position = () => {
      const rect = popover.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      popover.style.top = `${Math.max(top + 8, Math.min(quotedSelection.top, top + (viewport?.height ?? window.innerHeight) - rect.height - 8))}px`;
      popover.style.left = `${Math.max(left + 8, Math.min(quotedSelection.left - rect.width / 2, left + (viewport?.width ?? window.innerWidth) - rect.width - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(popover);
    window.addEventListener("resize", position);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [quotedSelection, quoteInputOpen, quoteError]);

  useEffect(() => {
    if (!quotedSelection) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!quoteInputOpen && !quotePopoverRef.current?.contains(event.target as Node)) closeQuotedSelection();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isImeComposing(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!quoteSubmitting) closeQuotedSelection();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [quotedSelection, quoteInputOpen, quoteSubmitting, closeQuotedSelection]);

  const quoteSelectionHere = useCallback(() => {
    if (!quotedSelection) return;
    chatInputRef?.current?.insertQuote(buildQuotedSelection(quotedSelection.text));
    // No `removeAllRanges()` here: inserting focuses the composer, and that
    // focus already collapses the page's selection. Calling it afterwards also
    // clears the composer's own selection and drops its caret to offset 0
    // (upstream #1319), so the quote would be typed in front of instead of after.
    closeQuotedSelection();
  }, [chatInputRef, quotedSelection, closeQuotedSelection]);

  const askSelectionInNewChat = useCallback(async (prompt: string) => {
    const sourceSessionId = sessionIdRef.current ?? session?.id;
    if (quoteSubmitting || !prompt.trim() || !quotedSelection?.sourceEntryId || !sourceSessionId || !onAskInNewChat) return;
    setQuoteSubmitting(true);
    setQuoteError(null);
    unlockAudio?.();
    try {
      await onAskInNewChat(
        prompt,
        sourceSessionId,
        quotedSelection.sourceEntryId,
      );
      closeQuotedSelection();
    } catch (error) {
      quoteChatInputRef.current?.restoreSubmission(prompt);
      setQuoteError(error instanceof Error ? error.message : String(error));
    } finally {
      setQuoteSubmitting(false);
    }
  }, [onAskInNewChat, quotedSelection, quoteSubmitting, session?.id, sessionIdRef, closeQuotedSelection, unlockAudio]);

  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (loading || error || !initialPrompt || initialPromptSentRef.current) return;
    initialPromptSentRef.current = true;
    onInitialPromptConsumed?.();
    void handleSend(initialPrompt);
  }, [initialPrompt, loading, error, handleSend, onInitialPromptConsumed]);

  const conversationTurns = useMemo<ConversationTurnLocation[]>(() => {
    const turns: ConversationTurnLocation[] = [];
    for (let userIdx = 0; userIdx < messages.length; userIdx++) {
      const question = getUserInputText(messages[userIdx]);
      if (!question) continue;
      let answer: string | null = null;
      for (let idx = userIdx + 1; idx < messages.length && messages[idx].role !== "user"; idx++) {
        answer = getAssistantPreviewText(messages[idx]) ?? answer;
      }
      turns.push({ index: turns.length, question, answer });
    }
    return turns;
  }, [messages]);

  // Fork/navigate stay referentially stable across busy transitions; gating
  // happens at call time (ref) and visually via the data-session-busy CSS
  // hook. Toggling these props between undefined and a function would defeat
  // every MessageView memo twice per agent turn.
  const sessionBusyRef = useRef(sessionBusy);
  sessionBusyRef.current = sessionBusy;


  // One sound when a dialog appears with none on screen. A dialog queued behind
  // another one surfaces the moment the user answers that one, so it stays quiet.
  useEffect(() => {
    const surfaced = Boolean(extensionDialog) && !extensionDialogShownRef.current;
    extensionDialogShownRef.current = Boolean(extensionDialog);
    if (!completionNotificationsEnabled || !surfaced) return;
    playDoneSoundRef.current();
  }, [completionNotificationsEnabled, extensionDialog]);

  // Register the abort handler for the global Esc shortcut. d5-14: needs a
  // cleanup — after unmount (workspace switch / sessionKey remount gap) the
  // module-level handler must not keep pointing at this stale abort.
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
    return () => {
      if (sessionBusy) registerAbortHandler(null);
    };
  }, [sessionBusy, handleAbort]);

  // --- Lazy-load historical messages ---
  // Only render the last N messages initially. When the user scrolls to the
  // top, load another page while keeping the scroll position stable.
  const lazyLoadSessionKey = session?.id ?? newSessionCwd ?? null;
  const [visibleCount, setVisibleCount] = useState(
    () => (lazyLoadSessionKey != null ? sessionVisibleCounts.get(lazyLoadSessionKey) : undefined) ?? VISIBLE_PAGE_SIZE,
  );
  const [appliedLazyLoadSessionKey, setAppliedLazyLoadSessionKey] = useState(lazyLoadSessionKey);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);
  // 「加载更早消息」失败时露出可点重试。loadContext 在 hook 内吞掉失败（只 console.error），
  // 但它成功时返回新一页 context、失败（或代次失效/卸载）时返回 undefined——以此判定失败。
  const [olderLoadFailed, setOlderLoadFailed] = useState(false);
  const restoreStartedRef = useRef(false);
  const pendingScrollRestoreRef = useRef(pendingScrollRestore);
  pendingScrollRestoreRef.current = pendingScrollRestore;
  const [pendingSearchScroll, setPendingSearchScroll] = useState<Props["searchTarget"]>(null);

  // ChatWindow intentionally stays mounted across session switches. Reset all
  // per-viewport state during render so the next commit cannot paint the old
  // session's window or consume its pending restoration state.
  if (lazyLoadSessionKey !== appliedLazyLoadSessionKey) {
    if (appliedLazyLoadSessionKey != null) {
      sessionVisibleCounts.set(appliedLazyLoadSessionKey, visibleCount);
    }
    setAppliedLazyLoadSessionKey(lazyLoadSessionKey);
    setVisibleCount(
      (lazyLoadSessionKey != null ? sessionVisibleCounts.get(lazyLoadSessionKey) : undefined)
        ?? VISIBLE_PAGE_SIZE,
    );
    const nextPosition = searchTarget ? null : initialScrollPosition ?? null;
    setPendingScrollRestore(nextPosition && !nextPosition.atBottom ? nextPosition : null);
    setRestoreAnchorReady(false);
    restoreStartedRef.current = false;
    loadingOlderRef.current = false;
    setOlderLoadFailed(false);
    prevScrollDistanceRef.current = null;
    setPendingSearchScroll(null);
  }
  const searchMessage = messages[entryIds.indexOf(pendingSearchScroll?.entryId ?? "")];
  const searchBlock = searchMessage?.role === "assistant"
    ? (pendingSearchScroll?.blockIndex === undefined
      ? searchMessage.content.find((block) => block.type === "text")
      : searchMessage.content[pendingSearchScroll.blockIndex])
    : undefined;
  const searchHistoryRef = useRef({ entryIds, historyCursor, hasEarlierMessages });
  searchHistoryRef.current = { entryIds, historyCursor, hasEarlierMessages };
  const scrollMemorySessionIdRef = useRef(session?.id ?? null);
  scrollMemorySessionIdRef.current = session?.id ?? null;
  const onScrollPositionChangeRef = useRef(onScrollPositionChange);
  onScrollPositionChangeRef.current = onScrollPositionChange;

  // d5-15：滚动保存的清理函数必须在「refs 真正挂上 DOM」之后注册。旧写法
  // deps [scrollContainerRef]（ref 对象恒定）且空引用早退——isEmptyNew 的挂载
  // 路径（两个 ref 的 DOM 不在树上，见下方 !isEmptyNew 条件渲染）此时早退，
  // 之后 refs 有值也不再补注册，该生命周期下卸载保存滚位整条失效。把「refs
  // 是否就绪」做成 state，就绪后重跑本 effect 才注册 cleanup。
  const [scrollRefsReady, setScrollRefsReady] = useState(false);
  useEffect(() => {
    setScrollRefsReady(Boolean(scrollContainerRef.current && messageContentRef.current));
  });
  useLayoutEffect(() => {
    if (!scrollRefsReady) return;
    const container = scrollContainerRef.current;
    const content = messageContentRef.current;
    if (!container || !content) return;
    return () => {
      const sessionId = scrollMemorySessionIdRef.current;
      const savePosition = onScrollPositionChangeRef.current;
      if (!sessionId || !savePosition) return;
      if (pendingScrollRestoreRef.current) return;
      if (isScrollAtTail(container.scrollTop, container.clientHeight, container.scrollHeight)) {
        savePosition(sessionId, { atBottom: true });
        return;
      }
      const viewportTop = container.getBoundingClientRect().top;
      const candidates = Array.from(content.children).flatMap((element) => {
        if (!(element instanceof HTMLElement) || !element.dataset.entryId) return [];
        const rect = element.getBoundingClientRect();
        return [{ entryId: element.dataset.entryId, top: rect.top, bottom: rect.bottom }];
      });
      const anchor = findChatScrollAnchor(candidates, viewportTop);
      if (!anchor) return;
      savePosition(sessionId, {
        atBottom: false,
        ...anchor,
        oldestEntryId: searchHistoryRef.current.historyCursor,
      });
    };
  }, [scrollRefsReady]);

  useEffect(() => {
    if (searchTarget) setPendingScrollRestore(null);
  }, [searchTarget]);

  useEffect(() => {
    const position = pendingScrollRestore;
    const sessionId = session?.id;
    if (!position || !sessionId || loading || searchTarget || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    const controller = new AbortController();

    const locate = async () => {
      const initialHistory = searchHistoryRef.current;
      if (initialHistory.entryIds.includes(position.anchorEntryId)) {
        setVisibleCount((current) => Math.max(current, initialHistory.entryIds.length * 2));
        setRestoreAnchorReady(true);
        return;
      }

      loadingOlderRef.current = true;
      let before = initialHistory.historyCursor;
      let hasMore = initialHistory.hasEarlierMessages;
      try {
        while (hasMore && before && !controller.signal.aborted) {
          const context = await loadContext(sessionId, activeLeafId, before, { signal: controller.signal });
          if (controller.signal.aborted) return;
          if (!context) {
            scrollToBottom("instant");
            setPendingScrollRestore(null);
            return;
          }
          setVisibleCount((current) => current + Math.max(VISIBLE_PAGE_SIZE, context.messages.length * 2));
          if (context.entryIds.includes(position.anchorEntryId)) {
            setRestoreAnchorReady(true);
            return;
          }
          if (context.oldestEntryId === position.oldestEntryId) break;
          before = context.oldestEntryId;
          hasMore = context.hasMore;
        }
        if (!controller.signal.aborted) {
          scrollToBottom("instant");
          setPendingScrollRestore(null);
        }
      } finally {
        loadingOlderRef.current = false;
      }
    };

    void locate();
    return () => {
      controller.abort();
      // A branch change cancels restoration and must reveal the new context.
      setPendingScrollRestore(null);
    };
  }, [activeLeafId, loadContext, loading, pendingScrollRestore, scrollToBottom, searchTarget, session?.id]);

  useLayoutEffect(() => {
    const position = pendingScrollRestore;
    const content = messageContentRef.current;
    if (!position || !content || searchTarget) return;
    const element = Array.from(content.children).find((candidate) => (
      candidate instanceof HTMLElement && candidate.dataset.entryId === position.anchorEntryId
    ));
    if (element instanceof HTMLElement) {
      scrollToMessage(element, position.anchorOffset);
      setPendingScrollRestore(null);
      return;
    }
    if (restoreAnchorReady) {
      scrollToBottom("instant");
      setPendingScrollRestore(null);
    }
  }, [entryIds, pendingScrollRestore, restoreAnchorReady, scrollToBottom, scrollToMessage, searchTarget, visibleCount]);

  useEffect(() => {
    if (!searchTarget || loading) return;
    const controller = new AbortController();
    const locate = async () => {
      const history = searchHistoryRef.current;
      let found = history.entryIds.includes(searchTarget.entryId);
      if (!found && !sessionBusy && history.hasEarlierMessages && history.historyCursor && !loadingOlderRef.current) {
        loadingOlderRef.current = true;
        const container = scrollContainerRef.current;
        if (container) prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
        // ponytail: one extra page of 200 entries; deeper or other-branch hits just open the session.
        const context = await loadContext(searchTarget.sessionId, activeLeafId, history.historyCursor, { tail: 200, signal: controller.signal });
        loadingOlderRef.current = false;
        found = Boolean(context && context.entryIds.includes(searchTarget.entryId));
      }
      if (controller.signal.aborted) return;
      if (found) {
        prevScrollDistanceRef.current = null;
        setVisibleCount((current) => Math.max(current, (searchHistoryRef.current.entryIds.length + 200) * 2));
        setPendingSearchScroll(searchTarget);
      } else {
        onSearchTargetHandled?.(searchTarget);
      }
    };
    void locate();
    return () => controller.abort();
  }, [searchTarget, loading, activeLeafId, sessionBusy, loadContext, onSearchTargetHandled, scrollContainerRef]);

  useLayoutEffect(() => {
    if (!pendingSearchScroll || pendingSearchScroll !== searchTarget) return;
    const selector = `[data-entry-id="${CSS.escape(pendingSearchScroll.entryId)}"]`;
    const element = scrollContainerRef.current?.querySelector<HTMLElement>(searchMessage?.role === "user" ? selector : `${selector} [data-search-target]`);
    if (element) {
      scrollToMessage(element);
      element.animate([
        { backgroundColor: "var(--bg-selected)" },
        { backgroundColor: "transparent" },
      ], { duration: 2500 });
    }
    setPendingSearchScroll(null);
    onSearchTargetHandled?.(pendingSearchScroll);
  }, [pendingSearchScroll, searchTarget, searchMessage, scrollContainerRef, scrollToMessage, onSearchTargetHandled]);

  // 加载更早消息：sentinel 自动触发与失败后点重试共用同一条路径。
  const loadOlderPage = useCallback(() => {
    if (loadingOlderRef.current) return;
    if (!hasEarlierMessages) return;
    const oldestId = historyCursor;
    if (!oldestId) return;
    const sid = session?.id ?? sessionIdRef.current;
    if (!sid) return;
    loadingOlderRef.current = true;
    setOlderLoadFailed(false);
    const container = scrollContainerRef.current;
    if (container) prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
    void loadContext(sid, activeLeafId, oldestId).then((context) => {
      // 成功返回新一页 context；失败/代次失效/卸载时返回 undefined。
      if (!context) setOlderLoadFailed(true);
    }, () => setOlderLoadFailed(true)).finally(() => {
      loadingOlderRef.current = false;
    });
  }, [hasEarlierMessages, historyCursor, session, activeLeafId, loadContext, sessionIdRef, scrollContainerRef]);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible, load the next page of older messages.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        // No older history loaded yet: fetch the previous page from the server
        // and prepend it (loadContext handles prepend + scroll anchoring).
        // Skip while a page is already loading or nothing older exists.
        loadOlderPage();
      },
      { root: container, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadOlderPage, scrollContainerRef]);

  // Keep the rendered window at least as large as what's loaded, so prepended
  // (older) pages stay visible instead of being sliced off the top.
  useEffect(() => {
    setVisibleCount((current) => Math.max(current, messages.length));
  }, [messages.length]);

  // After visibleCount increases (more messages prepended), restore the
  // scroll position so the viewport doesn't jump.
  useEffect(() => {
    if (prevScrollDistanceRef.current == null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    prevScrollDistanceRef.current = null;
  }, [visibleCount, scrollContainerRef]);
  // Push session stats up to AppShell for the stats panel and ring hover summary.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
      sessionStats.totalActiveMs ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  const cwd = chatOnly ? undefined : session?.cwd ?? newSessionCwd;
  // A chat with its own folder opens what it made in the right panel; a legacy
  // chat (shared hidden cwd) has no folder to show. The browser takes the folder
  // from the server-classified session, never from a path it builds itself.
  const chatFolderCwd = chatOnly && session?.chatFolder ? session.cwd : undefined;
  const openFile = chatOnly ? (chatFolderCwd ? onOpenFile : undefined) : onOpenFile;
  const projectImportBusyRef = useRef(false);

  // Documents/other files are copied into the project root and @mentioned so
  // the agent can read them with its normal tools — not inlined into the prompt.
  const importProjectFiles = useCallback((projectFiles: File[]) => {
    if (projectFiles.length === 0) return;
    if (chatOnly) {
      // A chat has no project to copy into: text files ride inside the message.
      void (async () => {
        const rejected = await chatInputRef?.current?.addTextFiles(projectFiles) ?? [];
        if (rejected.length === 0) return;
        const detail = rejected.slice(0, 3).map((item) => {
          const limit = item.reason === "too-many"
            ? String(item.limit)
            : "limit" in item ? formatAttachmentSize(item.limit) : "";
          return `${item.name}: ${t(`chat.attachReason.${item.reason}`, { limit })}`;
        }).join("; ");
        addNotice({ type: "error", message: t("chat.attachRejected", { detail }) });
      })();
      return;
    }
    if (!cwd) {
      addNotice({ type: "error", message: t("chat.dropNeedsProject") });
      return;
    }
    if (projectImportBusyRef.current) return;
    projectImportBusyRef.current = true;

    void (async () => {
      try {
        const result = await importDroppedProjectFiles(cwd, projectFiles);
        if (result.mentionText) {
          chatInputRef?.current?.insertText(result.mentionText);
          chatInputRef?.current?.focus();
        }
        if (result.uploaded.length > 0) onProjectFilesImported?.();

        const failureParts = [
          ...result.errors.map((item) => `${item.name}: ${item.error}`),
          ...result.rejected.map((item) => `${item.name}: ${item.reason}`),
        ];
        if (failureParts.length > 0) {
          addNotice({
            type: result.mentionText ? "warning" : "error",
            message: t("chat.dropProjectPartialFailure", { detail: failureParts.slice(0, 3).join("; ") }),
          });
        } else if (result.uploaded.length > 0 || result.skipped.length > 0) {
          addNotice({
            type: "success",
            message: t("chat.dropProjectSuccess", {
              count: result.uploaded.length + result.skipped.length,
            }),
          });
        }
      } catch (error) {
        addNotice({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        projectImportBusyRef.current = false;
      }
    })();
  }, [addNotice, chatInputRef, chatOnly, cwd, onProjectFilesImported, t]);

  const onDrop = useCallback((files: File[]) => {
    const { images, projectFiles } = partitionChatDroppedFiles(files);

    // Images stay on the multimodal attachment path; like the composer's
    // "+" picker they may be attached while a run is going (sent with the
    // next prompt), so the two entry points behave the same.
    if (images.length > 0) {
      chatInputRef?.current?.addImages(images);
    }
    importProjectFiles(projectFiles);
  }, [chatInputRef, importProjectFiles]);

  // The composer's "+" picker. The desktop WebView's file panel ignores the
  // input's `accept`, so any file can come back here: split it like a drop
  // instead of letting non-images vanish on the image-only path. Images may be
  // attached while a run is going, as before (they are sent with the next prompt).
  const onAttachFiles = useCallback((files: File[]) => {
    const { images, projectFiles } = partitionChatDroppedFiles(files);
    if (images.length > 0) chatInputRef?.current?.addImages(images);
    importProjectFiles(projectFiles);
  }, [chatInputRef, importProjectFiles]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  // Stable Map identity: `messages` doesn't change during streaming updates
  // (the streaming message lives in streaming store), so memoized MessageViews
  // skip re-rendering on every message_update event. An inline `new Map()`
  // here used to defeat MessageView's memo() on each streamed chunk.
  const toolResultsMap = useMemo(() => {
    // 空 toolCallId 是「provider 把流式 tool_call 分片各自成块」留下的残渣：多张卡片共用
    // "" 这个键，后写入的结果覆盖先写入的，于是所有同会话卡片显示同一条结果与时长。
    // 空 id 一律不入表，让这些卡片按「无结果」渲染，而不是互相串结果。
    const map = new Map<string, ToolResultMessage>();
    for (const [id, result] of activeToolResults) {
      if (id.trim()) map.set(id, result);
    }
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        const result = msg as ToolResultMessage;
        if (result.toolCallId?.trim()) map.set(result.toolCallId, result);
      }
    }
    return map;
  }, [activeToolResults, messages]);
  const inputHistory = useMemo(() => buildComposerHistory(messages), [messages]);

  const isEmptyNew = isNew && !loading && !error && messages.length === 0 && !isStreaming && !sessionBusy;
  useScrollbarVisibility(scrollContainerRef, Boolean(session?.id) || !isEmptyNew);

  // The message scrollport always shows its (usually invisible) scrollbar track,
  // so its width never changes with content. `scrollbar-gutter` would say the
  // same thing, but WebKit — the macOS desktop shell — does not reliably honour
  // it, so a short session growing past one screen shifted the column sideways.
  // The track still takes space on the right, which leaves the centred column
  // half a scrollbar left of the composer's. A hidden twin of the scrollport
  // reports how wide the track is (0 for overlay scrollbars) and the scrollport
  // pads its left edge by the same amount, so the message column, the composer
  // and the window all share one centre axis.
  const scrollbarGutterProbeRef = useRef<HTMLDivElement | null>(null);
  const [scrollbarGutter, setScrollbarGutter] = useState(0);
  useLayoutEffect(() => {
    const probe = scrollbarGutterProbeRef.current;
    if (!probe) return;
    const measure = () => {
      const next = Math.max(0, probe.offsetWidth - probe.clientWidth);
      setScrollbarGutter((previous) => (previous === next ? previous : next));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(probe);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // The bottom composer floats over the scrollport, so the text beside and
  // under its rounded box stays visible instead of being cut at a row edge.
  // The list ends with a spacer of the composer's live height so the last
  // lines can still scroll clear of it, and extension overlays stop above it
  // through --chat-composer-inset. Both are written straight to the DOM from
  // the ResizeObserver: upstream dropped an earlier state-driven spacer
  // because the extra render made streaming scroll-follow jitter.
  const composerOverlayRef = useRef<HTMLDivElement | null>(null);
  const composerOverlaySpacerRef = useRef<HTMLDivElement | null>(null);
  const chatContentRegionRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const composer = composerOverlayRef.current;
    const spacer = composerOverlaySpacerRef.current;
    const region = chatContentRegionRef.current;
    const container = scrollContainerRef.current;
    if (isEmptyNew || !composer || !spacer || !region || !container) return;
    let applied = -1;
    const apply = () => {
      const next = Math.ceil(composer.getBoundingClientRect().height);
      if (next === applied) return;
      // A viewport following the tail keeps following it as the composer
      // grows or shrinks; one scrolled into history keeps its scrollTop, and
      // the spacer sits below everything, so its content does not move.
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 2;
      applied = next;
      spacer.style.height = `${next}px`;
      region.style.setProperty("--chat-composer-inset", `${next}px`);
      if (atBottom) container.scrollTop = container.scrollHeight;
    };
    apply();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    observer?.observe(composer);
    return () => {
      observer?.disconnect();
      region.style.removeProperty("--chat-composer-inset");
    };
  }, [isEmptyNew, scrollContainerRef]);

  // Dialogs and popovers portal to document.body, so they sit outside the chat
  // column's DOM and cannot inherit its width. Publish the column's inner width
  // as a global CSS variable: the agent-team plan dialog sizes itself to
  // min(--chat-content-max-width, --chat-content-region-width, 100%), so it
  // stays exactly as wide as the composer and narrows with the column instead
  // of the viewport. Subtract the scrollbar gutter on both sides as well: the
  // composer wrapper mirrors the message scrollbar with
  // `paddingInline: scrollbarGutter`, so leaving it out makes the dialog wider
  // than the input by 2 × the gutter in a narrow column.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const region = chatContentRegionRef.current;
    if (!region) return;
    const apply = (width: number) => {
      const inner = Math.max(0, Math.round(width - scrollbarGutter * 2 - CHAT_COLUMN_PADDING * 2));
      document.documentElement.style.setProperty("--chat-content-region-width", `${inner}px`);
    };
    apply(region.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") {
      return () => document.documentElement.style.removeProperty("--chat-content-region-width");
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) apply(entry.contentRect.width);
    });
    observer.observe(region);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--chat-content-region-width");
    };
  }, [scrollbarGutter]);

  // hasStreamingContent now comes from the streaming store selectors above.
  const messageCwd = chatOnly ? chatFolderCwd : session?.cwd ?? newSessionCwd ?? undefined;
  // Keys that do not change when a sent or streamed message gets its entry id
  // on the post-run reload; keying by the id remounted the sent bubble.
  const messageKeyTrackerRef = useRef<{ sessionId: string | null; tracker: ReturnType<typeof createMessageKeyTracker> } | null>(null);
  const messageKeySessionId = session?.id ?? sessionIdRef.current ?? null;
  const messageKeys = useMemo(() => {
    let current = messageKeyTrackerRef.current;
    // A new session's id appears only after its first send; keep the tracker
    // across that null -> id step so the first bubble survives it too.
    if (!current || (current.sessionId !== null && current.sessionId !== messageKeySessionId)) {
      current = { sessionId: messageKeySessionId, tracker: createMessageKeyTracker() };
      messageKeyTrackerRef.current = current;
    }
    current.sessionId = messageKeySessionId;
    return assignMessageKeys(current.tracker, messages, entryIds);
  }, [messageKeySessionId, messages, entryIds]);
  const promptAnchorSpacerRef = useRef<HTMLDivElement | null>(null);
  const promptAnchorSpacerHeightRef = useRef(0);
  const promptAnchorMeasureFrameRef = useRef<number | null>(null);
  const promptAnchorAdjustmentDoneRef = useRef(false);
  const promptAnchorUpdateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const spacer = promptAnchorSpacerRef.current;
    if (!agentRunning || !promptAnchorActive) {
      promptAnchorUpdateRef.current = null;
      promptAnchorSpacerHeightRef.current = 0;
      promptAnchorAdjustmentDoneRef.current = false;
      if (spacer) spacer.style.height = "";
      return;
    }

    const container = scrollContainerRef.current;
    const messageContent = messageContentRef.current;
    const userMessage = lastUserMsgRef.current;
    if (!container || !messageContent || !userMessage || !spacer) return;

    let disposed = false;
    const updatePromptAnchorSpacer = () => {
      if (
        disposed
        || scrollContainerRef.current !== container
        || messageContentRef.current !== messageContent
        || lastUserMsgRef.current !== userMessage
        || promptAnchorSpacerRef.current !== spacer
      ) return;

      const containerTop = container.getBoundingClientRect().top;
      const userMessageTop = userMessage.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const targetTop = Math.max(0, userMessageTop - 16);
      const contentEnd = spacer.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const nextPromptAnchorSpacerHeight = getPromptAnchorSpacerHeight(
        targetTop,
        contentEnd,
        container.clientHeight,
        composerOverlaySpacerRef.current?.getBoundingClientRect().height ?? 0,
      );

      const isInitialMeasurement = !promptAnchorAdjustmentDoneRef.current;
      const needsInitialAdjustment = isInitialMeasurement
        && nextPromptAnchorSpacerHeight > 0;
      if (isInitialMeasurement) promptAnchorAdjustmentDoneRef.current = true;
      if (nextPromptAnchorSpacerHeight === promptAnchorSpacerHeightRef.current) return;

      promptAnchorSpacerHeightRef.current = nextPromptAnchorSpacerHeight;
      spacer.style.height = nextPromptAnchorSpacerHeight > 0
        ? `${nextPromptAnchorSpacerHeight}px`
        : "";
      if (needsInitialAdjustment) scrollUserMsgToTop();
    };

    promptAnchorUpdateRef.current = updatePromptAnchorSpacer;
    const schedulePromptAnchorMeasure = () => {
      if (disposed || promptAnchorMeasureFrameRef.current !== null) return;
      promptAnchorMeasureFrameRef.current = requestAnimationFrame(() => {
        promptAnchorMeasureFrameRef.current = null;
        updatePromptAnchorSpacer();
      });
    };

    updatePromptAnchorSpacer();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedulePromptAnchorMeasure);
    observer?.observe(container);
    observer?.observe(messageContent);
    observer?.observe(userMessage);
    return () => {
      disposed = true;
      if (promptAnchorUpdateRef.current === updatePromptAnchorSpacer) {
        promptAnchorUpdateRef.current = null;
      }
      observer?.disconnect();
      if (promptAnchorMeasureFrameRef.current !== null) {
        cancelAnimationFrame(promptAnchorMeasureFrameRef.current);
        promptAnchorMeasureFrameRef.current = null;
      }
    };
  }, [
    agentRunning,
    lastUserMsgRef,
    messages.length,
    promptAnchorActive,
    scrollContainerRef,
    scrollUserMsgToTop,
  ]);

  // Each streamed chunk StreamingReply commits, and the bubble coming and going.
  const updatePromptAnchor = useCallback(() => {
    promptAnchorUpdateRef.current?.();
  }, []);
  useLayoutEffect(updatePromptAnchor, [isStreaming, hasStreamingContent, updatePromptAnchor]);

  // The artifact panel follows the live reply: it reads the message through the
  // getter each commit, so a chunk re-renders StreamingReply alone.
  const streamingArtifactMessage = useStreamingSelector(streamingStore, (state) => state.isStreaming ? state.streamingMessage : null);
  useArtifactPublisher(
    session?.id ?? sessionIdRef.current,
    messages,
    streamingArtifactMessage,
    // While an earlier message is being edited, sending would replace that
    // branch, so the request waits in the composer instead.
    (text) => {
      if (editEntryId) chatInputRef?.current?.insertText(text);
      else void handleSend(text);
    },
  );


  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  // Jump to a conversation turn from the navigator rail. Turns can sit
  // outside the rendered window, so expand the window to the full branch
  // first, then scroll once the anchor is mounted. The window counts rendered
  // items, not messages: a turn's "Process details" group is one more item, so
  // messages.length alone left the first turn outside the window.
  const selectConversationTurn = useCallback((turnIndex: number) => {
    setVisibleCount((current) => Math.max(current, messages.length * 2));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      const anchor = container?.querySelector<HTMLElement>(`[data-conversation-turn="${turnIndex}"]`);
      if (!container || !anchor) return;
      const top = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 16;
      container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }));
  }, [messages.length, scrollContainerRef]);

  // B3 计划卡的数据源一：团队名。plan 路由按**团队名**读盘，所以先从会话 id 反查团队。
  // 只做一次性探测（跟随会话 id 与消息数变化），**不引入第二条 workbench 轮询** —— 持续
  // 刷新由 useTeamPlan 自己的 2s 轮询负责。取团队目录名（`team.id`）而不是显示名：目录名
  // 是 sanitize 后的稳定 id，查表幂等；中文团队名走显示名会变成一串横线。
  // 同一会话内不清空（避免卡片闪一下）：只在 sessionId 变化时才重算，读取时比对 sessionId。
  const teamProbeSessionId = session?.id ?? null;
  const [teamProbe, setTeamProbe] = useState<{ sessionId: string | null; name: string | null }>({
    sessionId: null,
    name: null,
  });
  useEffect(() => {
    if (!teamProbeSessionId) {
      setTeamProbe({ sessionId: null, name: null });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/teams/session/${encodeURIComponent(teamProbeSessionId)}/workbench`,
          { cache: "no-store" },
        );
        if (cancelled) return;
        if (!response.ok) {
          setTeamProbe({ sessionId: teamProbeSessionId, name: null });
          return;
        }
        const snapshot = await response.json() as { team?: { id?: unknown } };
        if (cancelled) return;
        const id = typeof snapshot.team?.id === "string" && snapshot.team.id ? snapshot.team.id : null;
        setTeamProbe({ sessionId: teamProbeSessionId, name: id });
      } catch {
        if (!cancelled) setTeamProbe({ sessionId: teamProbeSessionId, name: null });
      }
    })();
    return () => { cancelled = true; };
  }, [teamProbeSessionId, messages.length]);
  // 只在探测结果属于当前会话时才采用，防止切会话后拿上一条会话的团队名去查计划。
  const teamName = teamProbe.sessionId === teamProbeSessionId ? teamProbe.name : null;
  const teamPlan = useTeamPlan(teamName);
  // G2 目标进度条数据源：只在 status=active 时 2s 轮询；用 messages.length 作 refreshKey，
  // 让会话推进（新消息）时把随后新建/变化的目标补拉回来。
  const goalState = useGoalState(session?.id ?? null, messages.length);

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onClearDraft={cancelEdit}
      onAttachFiles={onAttachFiles}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
      workspaceUnavailable={workspaceUnavailable}
      onRecheckWorkspace={onRecheckWorkspace}
      modelScopeWarnings={modelScopeWarnings}
      onDismissModelScopeWarnings={dismissModelScopeWarnings}
      onOpenModelsConfig={onOpenModelsConfig}
      onModelChange={handleModelChange}
      modelSwitching={modelSwitching}
      defaultModel={defaultModel}
      onSetDefaultModel={handleSetDefaultModel}
      onCompact={session || isNew ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactNotice={compactNotice}
      compactResult={compactResult}
      summarizationRetry={summarizationRetry}
      toolPreset={toolPreset}
      onToolPresetChange={!chatOnly && (session || isNew) ? handleToolPresetChange : undefined}
      thinkingLevel={thinkingLevel}
      isAutoThinkingSelection={isAutoThinkingSelection}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      savedDefaultThinkingLevel={savedDefaultThinkingLevel}
      onSetDefaultThinkingLevel={session || isNew ? handleSetDefaultThinkingLevel : undefined}
      retryInfo={retryInfo}
      onAbortRetry={handleAbortRetry}
      branchSummaryPending={branchSummaryPending}
      routedModel={routedModel}
      onAbortBranchSummary={handleAbortBranchSummary}
      automation={automation}
      onSetAutomation={handleSetAutomation}
      queuedMessages={queuedMessages}
      onQueuedMessageAction={handleQueuedMessageAction}
      inputHistory={inputHistory}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      extensionUiOpen={Boolean(extensionDialog || extensionCustomUi)}
      onBuiltinCommand={handleBuiltinSlashCommand}
      onAudioUnlock={unlockAudio}
      autoFocus={isNew}
      draftKey={session?.id ?? newSessionDraftKey ?? undefined}
      agentTeamScope={agentTeamScopeKey(session?.id, newSessionCwd)}
      cwd={chatOnly ? undefined : session?.cwd ?? newSessionCwd}
      projectPath={chatOnly ? undefined : session?.projectRoot ?? session?.cwd ?? newSessionCwd}
      onSelectProject={chatOnly ? undefined : onSelectProject}
      projectOptions={chatOnly ? [] : projectOptions}
      onProjectChange={chatOnly ? undefined : onProjectChange}
      chatOnly={chatOnly}
      memberSession={session?.relation?.kind === "subagent"}
      onOpenSettings={onOpenSettings ? () => onOpenSettings("general") : undefined}
      chatAccess={chatAccess}
      onToggleChatUnlocked={handleToggleChatUnlocked}
      onSessionStatsPanelOpen={onSessionStatsPanelOpen}
      contextUsage={contextUsage}
      compactionLimits={compactionLimits}
      sessionStats={sessionStats}
    />
  );

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-red-400">
        <div>{error}</div>
        <button
          type="button"
          className="file-viewer-icon-button"
          onClick={retryLoad}
          style={{ width: "auto", height: 32, gap: 5, padding: "0 12px", border: "none", fontSize: "var(--fs-caption)", fontWeight: "var(--fw-medium)" }}
        >
          {t("common.retry")}
        </button>
      </div>
    );
  }

  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");
  const hasExtensionStatus = formatExtensionStatusLine(extensionStatuses).length > 0;

  return (
    <div
      className="chat-window chat-content relative flex h-full min-w-0 flex-col overflow-hidden"
      data-session-busy={sessionBusy ? "true" : undefined}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Search owns only rendered transcript text. Reveal the local window on
          open, but keep server history paging explicit and reuse loadContext's
          session/request guards. A leaf switch is a new search scope too. */}
      <ConversationFind
        contentRef={messageContentRef}
        scopeKey={`${lazyLoadSessionKey}:${activeLeafId}`}
        onReveal={() => setVisibleCount((count) => Math.max(count, messages.length))}
        hasEarlier={hasEarlierMessages}
        busy={sessionBusy || loading}
        onLoadEarlier={async () => {
          if (!session?.id || !historyCursor || loadingOlderRef.current || sessionBusy) return;
          // Share the sentinel's paging lock so search and scroll cannot prepend
          // the same page concurrently. Do not fetch older pages during a run.
          loadingOlderRef.current = true;
          try {
            const context = await loadContext(session.id, activeLeafId, historyCursor, { tail: 200 });
            if (context) setVisibleCount((count) => count + context.messages.length);
          } finally {
            loadingOlderRef.current = false;
          }
        }}
      />
      {/* Zero-content twin of the message scrollport: same scrollbar styling and
          a forced track, so it reports the exact width the real scrollbar takes
          before any content renders one. */}
      <div
        ref={scrollbarGutterProbeRef}
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 h-px w-24 overflow-y-scroll opacity-0"
      />

      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[var(--accent-soft)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[var(--accent-border)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          {/* Neutral gray constants: SVG presentation attributes can't resolve
              CSS vars, and this gray reads fine on both light and dark. */}
          <div className="relative z-[1] flex flex-col items-center gap-3 px-6 text-center">
            <svg
              width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
              className="drop-shadow-[0_6px_18px_var(--focus-ring)]"
            >
              <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(120,120,128,0.10)" stroke="rgba(120,120,128,0.55)" strokeWidth="1.8"/>
              <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(120,120,128,0.18)" stroke="rgba(120,120,128,0.45)" strokeWidth="1.4" strokeLinejoin="round"/>
              <circle cx="96" cy="58" r="8" fill="rgba(120,120,128,0.24)" stroke="rgba(120,120,128,0.60)" strokeWidth="1.6"/>
              <g stroke="rgba(120,120,128,0.50)" strokeWidth="1.4" strokeLinecap="round">
                <line x1="96" y1="46" x2="96" y2="43"/>
                <line x1="96" y1="70" x2="96" y2="73"/>
                <line x1="84" y1="58" x2="81" y2="58"/>
                <line x1="108" y1="58" x2="111" y2="58"/>
                <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
                <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
                <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
                <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
              </g>
            </svg>
            <div style={{ maxWidth: 320, color: "var(--text)", fontSize: "var(--fs-body)", fontWeight: "var(--fw-medium)", lineHeight: 1.35 }}>
              {t(chatOnly ? "chat.dropImagesHint" : "chat.dropFilesHint")}
            </div>
            <div style={{ maxWidth: 360, color: "var(--text-muted)", fontSize: "var(--fs-caption)", lineHeight: 1.4 }}>
              {t(chatOnly ? "chat.dropImagesDetail" : "chat.dropFilesDetail")}
            </div>
          </div>
        </div>
      )}

      <div
        style={{
          position: "absolute",
          top: 12,
          left: 0,
          right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
          zIndex: 40,
          display: "flex",
          // Toasts live in the top-right corner
          justifyContent: "flex-end",
          padding: `0 ${CHAT_COLUMN_PADDING}px`,
          pointerEvents: "none",
        }}
      >
        <NoticeShelf notices={notices} floating onPauseChange={setNoticePaused} />
      </div>

      {/* Composer overlays the scrollport; trailing spacer clears the last lines. */}
      <div ref={chatContentRegionRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {extensionDialog && (
          <ExtensionDialog key={extensionDialog.id} request={extensionDialog} waitingCount={waitingExtensionDialogCount} onRespond={respondToExtensionUi} />
        )}
        {extensionCustomUi && (
          <ExtensionCustomPanel key={extensionCustomUi.id} request={extensionCustomUi} waitingCount={waitingExtensionCustomUiCount} onInput={sendExtensionCustomInput} />
        )}
        {!isEmptyNew && <>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, flex: 1, overflow: "hidden" }}>
        {/* G2 目标进度条 + 会话头部团队条：都常驻在消息列表上方（照 cc-haha ActiveSession
            header 位，两者相邻、都是整宽横幅）。包一层 column 让条位于列表之上，**不改**
            chatContentRegion 的 row（ConversationNavigator 仍是它的同行子项）。无目标 / 无团队时
            各自返回 null，不留空位；这里只负责与消息列一致的居中内边距。 */}
        <div style={{ flexShrink: 0, padding: `0 ${CHAT_COLUMN_PADDING}px`, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ width: "100%", maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
            <SessionTitleStrip session={session} compact={isMobile} onRenamed={onSessionRenamed} />
            <GoalStrip goal={goalState.goal} isRunning={sessionRunning} compact={isMobile} />
            {teamStrip}
            <OutageBanner sessionId={session?.id ?? null} />
          </div>
        </div>
        <div
          ref={scrollContainerRef}
          // The message list is the one place long output has to be dragged through,
          // so it shows its scrollbar instead of hiding it behind the minimap (#788).
          // The track is always there (its thumb only shows while scrolling), so
          // the centred column cannot shift when a short session grows past one
          // screen; the left padding mirrors it to centre the column on the
          // composer's axis.
          className="chat-scroll-container scrollbar-subtle min-w-0 flex-1 overflow-x-hidden overflow-y-scroll pt-4"
          style={{
            paddingLeft: scrollbarGutter > 0 ? scrollbarGutter : undefined,
            visibility: pendingScrollRestore && !loading ? "hidden" : undefined,
          }}
        >
          <div style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div ref={messageContentRef} onPointerUp={captureQuotedSelection} style={{ width: "100%", minWidth: 0, maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
            {loading ? (
              <div className="chat-loading-hint">{t("chat.loadingSession")}</div>
            ) : (() => {
              let lastUserIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") { lastUserIdx = i; break; }
              }
              // Anchor for live-tail detection. A compaction summary or subagent
              // completion can sit after the last user message and own the
              // still-streaming segment. lastUserIdx stays the scroll target.
              let lastAnchorIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (isMessageGroupAnchor(messages[i])) { lastAnchorIdx = i; break; }
              }

              const visibleRefIndexByMessage = new Map<number, number>();
              let refIdx = 0;
              messages.forEach((msg, idx) => {
                if (isMessageGroupAnchor(msg) || msg.role === "assistant") {
                  visibleRefIndexByMessage.set(idx, refIdx++);
                }
              });

              // Turn numbers for the navigator rail: they must count user messages
              // exactly like `conversationTurns`, whose indexes the rail selects.
              const turnIndexByMessageIndex = new Map<number, number>();
              let nextTurnIndex = 0;
              messages.forEach((msg, idx) => {
                if (getUserInputText(msg)) turnIndexByMessageIndex.set(idx, nextTurnIndex++);
              });

              const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                messageRefs.current[refIndex] = el;
                if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
              };

              const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean; writtenFiles?: WrittenFile[]; recoverTruncation?: boolean; turnDurationMs?: number } = {}): ReactNode => {
                const msg = options.messageOverride ?? messages[idx];
                const isVisible = isMessageGroupAnchor(msg) || msg.role === "assistant";
                const currentRefIdx = visibleRefIndexByMessage.get(idx);
                const keyPrefix = options.keyPrefix ?? "message";
                const messageKey = messageKeys[idx] ?? idx;
                let showTimestamp = false;
                if (msg.role === "assistant") {
                  showTimestamp = true;
                  for (let j = idx + 1; j < messages.length; j++) {
                    const r = messages[j].role;
                    if (r === "user") break;
                    if (r === "assistant") { showTimestamp = false; break; }
                  }
                  // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                  if (showTimestamp && isStreaming && idx === messages.length - 1) {
                    showTimestamp = false;
                  }
                }
                if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
                const view = (
                  <MessageView
                    key={`${keyPrefix}-view-${messageKey}`}
                    message={msg}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    cwd={messageCwd}
                    onOpenFile={openFile}
                    onOpenSession={onOpenSession}
                    entryId={entryIds[idx]}
                    searchBlock={entryIds[idx] === pendingSearchScroll?.entryId ? searchBlock : undefined}
                    onFork={bashRunning || isNew ? undefined : forkFromMessage}
                    forking={forkingEntryId === entryIds[idx]}
                    onEditContent={handleEditContent}
                    editDisabled={sessionBusy}
                    onCancelEdit={cancelEdit}
                    isEditing={editEntryId === entryIds[idx]}
                    showTimestamp={showTimestamp}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    writtenFiles={options.writtenFiles}
                    turnDurationMs={options.turnDurationMs}
                    onCompact={options.recoverTruncation ? handleCompact : undefined}
                    isCompacting={options.recoverTruncation ? isCompacting : undefined}
                    compactError={options.recoverTruncation ? compactError : undefined}
                  />
                );
                if (!isVisible || currentRefIdx === undefined) return view;
                return (
                  <div
                    key={`${keyPrefix}-${messageKey}`}
                    data-entry-id={entryIds[idx]}
                    data-conversation-turn={turnIndexByMessageIndex.get(idx)}
                    ref={options.attachRef === false ? undefined : attachVisibleRef(idx, currentRefIdx)}>
                    {view}
                  </div>
                );
              };

              const rendered: ReactNode[] = [];
              for (let idx = 0; idx < messages.length;) {
                const msg = messages[idx];
                const hasAnchor = isMessageGroupAnchor(msg);
                if (!hasAnchor && idx !== 0) {
                  rendered.push(renderMessage(idx));
                  idx += 1;
                  continue;
                }

                // The first history page starts at a fixed entry count, so a turn
                // longer than that page begins without its anchor. Group the
                // leading segment anyway instead of flattening the whole turn.
                const userIdx = hasAnchor ? idx : -1;
                const groupStartIdx = hasAnchor ? idx : 0;
                let endIdx = idx + 1;
                while (endIdx < messages.length && !isMessageGroupAnchor(messages[endIdx])) endIdx += 1;

                const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);

                if (finalAssistantIdx === -1) {
                  for (let renderIdx = groupStartIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }
                  idx = endIdx;
                  continue;
                }

                const isLiveTail = (sessionBusy || isStreaming) && endIdx === messages.length && userIdx === lastAnchorIdx;
                if (isLiveTail) {
                  for (let renderIdx = groupStartIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }
                  idx = endIdx;
                  continue;
                }

                if (hasAnchor) rendered.push(renderMessage(userIdx));

                // A leading segment without its anchor has no start time, and neither has the bubble a
                // send shows at once: it carries the browser's clock, not pi's, until the reload after
                // the run brings the session file's entry (the only kind with an entry id).
                const turnDurationMs = hasAnchor && entryIds[userIdx] ? getTurnDurationMs(messages, userIdx, endIdx) : undefined;

                const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
                const { answerMessage: finalAnswerMessage, processMessage: finalProcessMessage } = getFinalSplit(finalAssistant);

                const processViews: ReactNode[] = [];
                let processToolCount = 0;
                const processToolCalls: ToolSummaryInput[] = [];
                let processRefIdx: number | undefined;
                let revealProcess = false;

                for (let processIdx = userIdx + 1; processIdx <= finalAssistantIdx; processIdx++) {
                  const processMessage = messages[processIdx];
                  if (processMessage.role === "custom") {
                    revealProcess ||= Boolean(pendingSearchScroll && pendingSearchScroll.entryId === entryIds[processIdx]);
                    processViews.push(renderMessage(processIdx, { attachRef: false, keyPrefix: "process" }));
                    continue;
                  }
                  if (processMessage.role !== "assistant") continue;
                  const message = processIdx === finalAssistantIdx ? finalProcessMessage : processMessage;
                  const blocks = getDisplayableAssistantBlocks(message);
                  if (blocks.length === 0) continue;
                  processRefIdx ??= visibleRefIndexByMessage.get(processIdx);
                  processToolCount += countToolCallBlocks(blocks);
                  for (const block of blocks) {
                    if (block.type === "toolCall") processToolCalls.push({ toolName: block.toolName, input: block.input });
                  }
                  revealProcess ||= Boolean(pendingSearchScroll && entryIds[processIdx] === pendingSearchScroll.entryId && (!searchBlock || blocks.includes(searchBlock)));
                  processViews.push(renderMessage(processIdx, {
                    attachRef: false,
                    keyPrefix: "process",
                    messageOverride: message,
                    showTimestamp: false,
                  }));
                }

                if (processViews.length > 0) {
                  rendered.push(
                    <div
                      key={`process-group-${messageKeys[groupStartIdx] ?? groupStartIdx}`}
                      ref={processRefIdx === undefined ? undefined : (el) => { messageRefs.current[processRefIdx] = el; }}
                    >
                      {/* Re-key on answer availability: useState reads defaultExpanded only
                          on mount, so a turn first rendered without an answer (expanded)
                          would otherwise stay open once its answer shows up, e.g. when
                          switching between an answered and an unanswered leaf of the same
                          turn. Manual toggles survive every other re-render. */}
                      <ProcessDetailsGroup key={finalAnswerMessage ? "answered" : "unanswered"} messageCount={processViews.length} toolCallCount={processToolCount} toolSegments={summarizeToolCalls(processToolCalls)} durationMs={turnDurationMs} defaultExpanded={!finalAnswerMessage} reveal={revealProcess} t={t}>
                        {processViews}
                      </ProcessDetailsGroup>
                    </div>,
                  );
                }

                if (finalAnswerMessage) {
                  // Each tool call is stored as its own assistant entry, so the
                  // final answer alone carries no record of what the turn wrote.
                  // Gather the turn's assistant blocks and derive the file list
                  // from the write/edit calls among them.
                  const writtenFiles = getTurnWrittenFiles(finalAssistant, messages.slice(userIdx + 1, finalAssistantIdx + 1), toolResultsMap, messageCwd);
                  rendered.push(renderMessage(finalAssistantIdx, {
                    messageOverride: finalAnswerMessage,
                    writtenFiles,
                    // Without process details the turn's time goes under the answer.
                    turnDurationMs: processViews.length === 0 ? turnDurationMs : undefined,
                    recoverTruncation: endIdx === messages.length && !isStreaming && !hasAssistantAnswer(finalAnswerMessage),
                  }));
                }
                for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
                  rendered.push(renderMessage(renderIdx));
                }
                idx = endIdx;
              }
              const { startIndex } = getVisibleRenderWindow(rendered.length, visibleCount);
              const hasMore = startIndex > 0 || hasEarlierMessages;
              return (
                <>
                  {hasMore && (
                    <>
                      {olderLoadFailed && (
                        <button
                          type="button"
                          onClick={loadOlderPage}
                          style={{
                            display: "block",
                            width: "100%",
                            padding: "10px 0",
                            background: "none",
                            border: "none",
                            color: "var(--danger)",
                            fontSize: "var(--fs-caption)",
                            textAlign: "center",
                            cursor: "pointer",
                          }}
                        >
                          {t("chat.loadEarlierFailed")}
                        </button>
                      )}
                      <div ref={sentinelRef} className="py-3 text-center text-xs text-text-muted">
                        {olderLoadFailed ? null : t("chat.loadEarlier")}
                      </div>
                    </>
                  )}
                  {rendered.slice(startIndex)}
                </>
              );
            })()}
            {isStreaming && hasStreamingContent && (
              <StreamingReply store={streamingStore} onCommit={updatePromptAnchor} toolResults={toolResultsMap} modelNames={modelNames} cwd={messageCwd} onOpenFile={openFile} onOpenSession={onOpenSession} />
            )}

            {(agentRunning || isCompacting) && !hasStreamingContent && (agentPhase || isCompacting) && (
              <div className="break-words py-2 text-[13px] text-text-muted">
                <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase, t, isCompacting, (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0))}</span>
              </div>
            )}

            {bashRunning && !pendingBash && (
              <div className="py-2 text-[13px] text-text-muted">
                 <span className="animate-[pulse_1.5s_infinite]">{t("chat.runningCommand")}</span>
              </div>
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: pendingBash.output,
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                onOpenSession={onOpenSession}
              />
            )}

            <div ref={promptAnchorSpacerRef} aria-hidden="true" />
            <div ref={composerOverlaySpacerRef} aria-hidden="true" />
            </div>
          </div>
        </div>
        </div>
          <ConversationNavigator
            turns={conversationTurns}
            scrollContainerRef={scrollContainerRef}
            contentRef={messageContentRef}
            enabled={conversationNavigatorEnabled}
            onSelect={selectConversationTurn}
          />
        </>
        }
      </div>

      {quoteSelectionEnabled && quotedSelection && createPortal(
        <div
          ref={quotePopoverRef}
          role={quoteInputOpen ? "dialog" : "toolbar"}
          aria-label={t(quoteInputOpen ? "chat.newQuoteChat" : "chat.selectionActions")}
          style={{
            position: "fixed",
            top: quotedSelection.top,
            left: quotedSelection.left,
            zIndex: 260,
            display: "flex",
            flexWrap: "wrap",
            gap: 3,
            width: quoteInputOpen ? "min(420px, calc(100vw - 16px))" : undefined,
            maxWidth: "calc(100vw - 16px)",
            maxHeight: "calc(var(--app-viewport-height, 100dvh) - 16px)",
            overflowY: "auto",
            padding: quoteInputOpen ? 12 : 3,
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-sm)",
            background: "var(--bg)",
            boxShadow: "var(--shadow-popover)",
          }}
        >
          {quoteInputOpen ? (
            <fieldset
              disabled={quoteSubmitting}
              aria-busy={quoteSubmitting}
              style={{ width: "100%", minWidth: 0, margin: 0, padding: 0, border: "none", display: "flex", flexDirection: "column", gap: 10 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: "var(--fs-caption)", fontWeight: "var(--fw-semibold)" }}>{t("chat.askInNewChat")}</span>
                <button type="button" className="file-viewer-icon-button" title={t("i18n.close")} aria-label={t("i18n.close")} disabled={quoteSubmitting} onClick={closeQuotedSelection} style={{ border: "none" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
                </button>
              </div>
              <ChatInput
                ref={quoteChatInputRef}
                compact
                onSend={askSelectionInNewChat}
                onAbort={closeQuotedSelection}
                isStreaming={false}
              />
              {quoteError && <div role="alert" style={{ color: "var(--danger)", fontSize: "var(--fs-caption)", overflowWrap: "anywhere" }}>{quoteError}</div>}
            </fieldset>
          ) : <>
          <button
            type="button"
            className="file-viewer-icon-button"
            title={t("chat.quoteSelection")}
            aria-label={t("chat.quoteSelection")}
            onPointerDown={(event) => event.preventDefault()}
            onClick={quoteSelectionHere}
            style={{ width: "auto", height: 35, flex: "0 0 auto", gap: 5, padding: "0 10px", border: "none", fontSize: "var(--fs-caption)", fontWeight: "var(--fw-medium)" }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" />
              <path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" />
            </svg>
            <span>{t("chat.quoteSelection")}</span>
          </button>
          {onAskInNewChat && quotedSelection.sourceEntryId && !bashRunning && (
            <button
              type="button"
              className="file-viewer-icon-button"
              title={t("chat.askInNewChat")}
              aria-label={t("chat.askInNewChat")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => { setQuoteInputOpen(true); window.getSelection()?.removeAllRanges(); }}
              style={{ width: "auto", height: 35, flex: "0 0 auto", gap: 5, padding: "0 10px", border: "none", fontSize: "var(--fs-caption)", fontWeight: "var(--fw-medium)" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 3v12M18 9a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
              </svg>
              <span>{t("chat.askInNewChat")}</span>
            </button>
          )}
          </>}
        </div>,
        document.body,
      )}

      {/* Inset by the scrollbar track on both sides: the message column is
          inset by it on the left (padding) and right (the track itself), so
          the composer keeps the same width once the window is narrower than
          the max column width. */}
      <div
        ref={composerOverlayRef}
        className={isEmptyNew ? "relative shrink-0" : "chat-composer-overlay absolute inset-x-0 z-20"}
        style={{
          ...(isEmptyNew ? {} : { bottom: "env(safe-area-inset-bottom)" }),
          ...(scrollbarGutter > 0 ? { paddingInline: scrollbarGutter } : {}),
        }}
      >
        {!isEmptyNew && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
              display: "flex",
              justifyContent: "center",
              paddingBottom: 10,
              pointerEvents: "none",
              zIndex: 20,
            }}
          >
            <button
              type="button"
              className={`chat-scroll-to-bottom${showScrollToBottom && !pendingScrollRestore ? " is-visible" : ""}`}
              title={t("chat.scrollToLatest")}
              aria-label={t("chat.scrollToLatest")}
              onClick={() => scrollToBottom("smooth")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
            </button>
          </div>
        )}
        {aboveEditorWidgets.length > 0 && (
          <div className="mb-2 w-full" style={{ padding: "0 16px" }}>
            <div style={{ maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
              <ExtensionWidgets widgets={aboveEditorWidgets} />
            </div>
          </div>
        )}
        {chatNeedsShell && chatAccess && (
          <ChatShellPrompt
            busy={chatAccess.busy}
            error={chatAccess.error}
            onAllow={() => {
              void chatAccess.setUnlocked(true).then((ok) => {
                if (ok) void handleSend(t("chat.chatShellPromptContinue"));
              });
            }}
          />
        )}
        {isEmptyNew && (
          <NewSessionWelcome
            cwd={newSessionCwd}
            isChat={chatOnly}
          />
        )}
        {/* B3: plan card dock above the composer.
            宽度口径必须与输入框**完全一致**，否则卡片会横着铺满整个聊天列、比输入框宽一截
            （用户 2026-11 截图反馈的「太宽」就是这个）：
            - ChatInput 根节点是 `padding: 0 16px 8px`，内层才是
              「max-width = 聊天外观宽度（820px）+ margin auto」居中；
            - 所以这里也套同样的两层：外层吃 16px 内边距，内层取同一个 max-width 居中。
            只给外层上 max-width 是不够的——那会让卡片比输入框宽 2 倍内边距。
            继续用 flexShrink: 0 + 限高滚动（计划卡自己也有 maxHeight，这里是双保险）。
            可见性判据同时接受「没有 plan 但读取出错」：卡片会渲染一条 loadFailed 提示，
            轮询失败时不再静默消失（之前 `isPlanCardVisible(null)` 恒 false，那条分支是死代码）。 */}
        {(isPlanCardVisible(teamPlan.plan) || (!teamPlan.plan && Boolean(teamPlan.error))) && (
          <div
            style={{
              width: "100%",
              padding: `0 ${CHAT_COLUMN_PADDING}px`,
              marginBottom: 8,
              flexShrink: 0,
              minWidth: 0,
            }}
          >
            <div
              style={{
                maxWidth: "var(--chat-content-max-width, 820px)",
                margin: "0 auto",
                maxHeight: "min(45dvh, 440px)",
                overflowY: "auto",
                minWidth: 0,
              }}
            >
              <AgentTeamPlanCard
                plan={teamPlan.plan}
                cwd={session?.cwd ?? null}
                busy={teamPlan.busy}
                saving={teamPlan.saving}
                saveError={teamPlan.saveError}
                conflict={teamPlan.conflict}
                error={teamPlan.error}
                approveError={teamPlan.approveError}
                onApprove={(edits) => void teamPlan.saveAndApprove(edits)}
                onReload={teamPlan.refresh}
                onStop={() => void handleAbort()}
              />
            </div>
          </div>
        )}
        {chatInputElement}
        <StreamingRateLine store={streamingStore} />
        {(belowEditorWidgets.length > 0 || hasExtensionStatus) && (
          <div className={`extension-status-shelf${belowEditorWidgets.length > 0 ? " has-widgets" : ""}${hasExtensionStatus ? " has-status" : ""}`}>
            {belowEditorWidgets.length > 0 && <ExtensionWidgets widgets={belowEditorWidgets} />}
            {hasExtensionStatus && <ExtensionStatusLine statuses={extensionStatuses} />}
          </div>
        )}
      </div>
      {isEmptyNew && <div className="min-h-0 flex-1" />}
    </div>
  );
}

// Toast 整体高度上限；文本区高度上限 = 整体上限 - 上下 padding(14*2) - 上下边框(1*2)
const NOTICE_MAX_HEIGHT_PX = 500;
const NOTICE_TEXT_MAX_HEIGHT_PX = NOTICE_MAX_HEIGHT_PX - 30;

function NoticeShelf({ notices, floating = false, onPauseChange }: { notices: NoticeItem[]; floating?: boolean; onPauseChange?: (id: string | null) => void }) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // Right-anchored: every toast's right edge aligns here, widths extend leftward
        alignItems: "flex-end",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "var(--danger)"
          : notice.type === "warning"
            ? "var(--warning)"
            : notice.type === "success"
              ? "var(--success)"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className={`notice-shelf-item is-${notice.type}${floating ? " is-floating" : ""}`}
            onMouseEnter={() => onPauseChange?.(notice.id)}
            onMouseLeave={(event) => {
              if (!event.currentTarget.contains(document.activeElement)) onPauseChange?.(null);
            }}
            onFocus={() => onPauseChange?.(notice.id)}
            onBlur={(event) => {
              if (!event.currentTarget.matches(":hover")) onPauseChange?.(null);
            }}
            style={{
              display: "flex",
              // Top-align children so the type dot sits by the first line on multi-line toasts
              alignItems: "flex-start",
              gap: 10,
              minHeight: 60,
              height: "auto",
              // 整体高度上限：超出后由文本区内部滚动承担（见下方 span 的 overflowY），
              // 容器自身保持 hidden，小圆点固定在顶部不随文本滚动
              maxHeight: NOTICE_MAX_HEIGHT_PX,
              // The floating wrapper is pointerEvents:"none" (click-through by design),
              // so the toast itself must opt back into interactivity or hover events never reach it
              pointerEvents: "auto",
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: "var(--radius-lg)",
              border: "var(--hairline) solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "var(--shadow-composer)",
              fontSize: 14,
              lineHeight: 1.5,
              transformOrigin: "top right",
              // Use backwards fill for the entrance animation so height styles return to
              // inline styles once it finishes; otherwise the keyframe's fixed 60px would
              // stick around in fill mode and permanently clamp the expanded toast
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out backwards",
              padding: "0 12px",
            }}
          >
            <span
              className="notice-shelf-indicator"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
                // Align with the optical center of the first text line: 14px vertical
                // padding + (21px line box - 7px dot) / 2
                marginTop: 21,
              }}
            />
            <span
              tabIndex={0}
              style={{ padding: "14px 0", minWidth: 0, maxWidth: "100%", maxHeight: NOTICE_TEXT_MAX_HEIGHT_PX, overflowY: "auto", scrollbarWidth: "thin", whiteSpace: "pre-line", wordBreak: "break-word" }}
            >
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function getExtensionDialogSummary(request: ExtensionDialogRequest): string | undefined {
  if (request.method === "select" && request.options.length > 0) return request.options[0];
  if (request.method === "confirm") {
    const firstLine = request.message.split("\n").find((line) => line.trim());
    return firstLine?.trim();
  }
  return undefined;
}

function extractMcpAuthorizationUrl(request: ExtensionDialogRequest): string | null {
  if (request.method !== "input") return null;
  const text = `${request.title}\n${request.placeholder ?? ""}`;
  const match = text.match(/https:\/\/[^\s<>"']+/i);
  return match?.[0] ?? null;
}

/** "+N more": requests of the same kind queued behind the one on screen, each shown once that one closes. */
function ExtensionWaitingCount({ count }: { count: number }) {
  const { t } = useI18n();
  if (count <= 0) return null;
  return (
    <span style={{ fontSize: "var(--fs-micro)", fontWeight: "var(--fw-semibold)", color: "var(--accent)", whiteSpace: "nowrap", flexShrink: 0 }}>
      {t("chat.extensionMoreWaiting", { count })}
    </span>
  );
}

function ExtensionDialog({
  request,
  waitingCount,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  /** Further dialogs queued behind this one; each opens after this one is answered. */
  waitingCount: number;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const focusFirstOption = useCallback((element: HTMLDivElement | null) => element?.focus(), []);
  const summary = getExtensionDialogSummary(request);
  const authorizationUrl = extractMcpAuthorizationUrl(request);
  const remainingSeconds = request.expiresAt === undefined
    ? null
    : Math.max(0, Math.ceil((request.expiresAt - now) / 1000));

  useEffect(() => {
    if (request.expiresAt === undefined) return;
    // The server closes expired requests via extension_ui_closed.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.expiresAt]);

  const countdown = remainingSeconds !== null && (
    <span style={{ fontSize: "var(--fs-micro)", color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>
      {t("chat.extensionExpiresIn", { seconds: remainingSeconds })}
    </span>
  );

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      onKeyDown={(event) => {
        if (event.key !== "Escape" || isImeComposing(event)) return;
        event.preventDefault();
        event.stopPropagation();
        onRespond(request, { cancelled: true });
      }}
      style={{
        position: "absolute",
        inset: 0,
        bottom: "var(--chat-composer-inset, 0px)",
        zIndex: "var(--z-chrome)",
        display: "flex",
        alignItems: collapsed ? "flex-start" : "center",
        justifyContent: "center",
        padding: 20,
        pointerEvents: "none",
      }}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "min(560px, 100%)",
            width: "100%",
            padding: "10px 12px",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-md)",
            background: "var(--bg)",
            boxShadow: "var(--shadow-popover)",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: "var(--fs-micro)", fontWeight: "var(--fw-semibold)", color: "var(--accent)", flexShrink: 0 }}>
            {t("chat.extensionPending")}
          </span>
          <span style={{ fontSize: "var(--fs-body)", fontWeight: "var(--fw-semibold)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {request.title}
          </span>
          {summary && (
            <span style={{ fontSize: "var(--fs-caption)", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%", flexShrink: 1 }}>
              {summary}
            </span>
          )}
          <ExtensionWaitingCount count={waitingCount} />
          {countdown}
          <span style={{ fontSize: "var(--fs-caption)", color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        role="dialog"
        aria-label={request.title}
        style={{
          pointerEvents: "auto",
          width: "min(560px, 100%)",
          maxHeight: "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-md)",
          background: "var(--bg)",
          boxShadow: "var(--shadow-dialog)",
          overflow: "hidden",
        }}
      >
        <div style={{ flexShrink: 1, minHeight: 0, display: "flex", alignItems: "flex-start", gap: 8, padding: "12px 14px", borderBottom: "var(--hairline) solid var(--border)", maxHeight: "50vh", overflowY: "auto" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Pi's TUI shows the title verbatim, newlines included; select/input have no
                separate message field, so extensions put multi-line text here. */}
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: "var(--fw-semibold)", lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{request.title}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 3, color: "var(--text-dim)", fontSize: "var(--fs-micro)", fontFamily: "var(--font-mono)" }}>
              <span>{t("chat.extensionRequest")}</span>
              <ExtensionWaitingCount count={waitingCount} />
              {countdown}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-expanded={true}
            title={t("chat.extensionCollapse")}
            aria-label={t("chat.extensionCollapse")}
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              borderRadius: "var(--radius-sm)",
              border: "var(--hairline) solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="2 3.5 5 6.5 8 3.5" />
            </svg>
          </button>
        </div>

        <div
          style={{
            padding: 14,
            flex: "1 1 auto", minHeight: 0, overflowY: "auto",
          }}
        >
          {request.method === "confirm" && (
            <MarkdownBody>{request.message}</MarkdownBody>
          )}
          {request.method === "select" && (
            <div
              onKeyDown={(event) => {
                if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-extension-option]"));
                const index = buttons.indexOf(event.target as HTMLElement);
                if (index < 0) return;
                event.preventDefault();
                const next = event.key === "Home" ? 0
                  : event.key === "End" ? buttons.length - 1
                  : (index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
                buttons[next].focus({ preventScroll: true });
                buttons[next].scrollIntoView({ block: "nearest" });
              }}
              style={{ display: "grid", gap: 8 }}
            >
              {request.options.map((option, index) => (
                <div
                  key={option}
                  role="button"
                  tabIndex={0}
                  data-extension-option
                  aria-label={option}
                  ref={index === 0 ? focusFirstOption : undefined}
                  onClick={() => onRespond(request, { value: option })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onRespond(request, { value: option });
                  }}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: "var(--radius-md)",
                    border: "var(--hairline) solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: "var(--fs-body)",
                    overflowWrap: "anywhere",
                    // Match the scroller's padding so keyboard navigation never parks the
                    // option flush against the edge, where whole-pixel scroll snapping and
                    // overflow clipping cut off its focus ring.
                    scrollMargin: 14,
                  }}
                >
                  <div inert>
                    <MarkdownBody>{option}</MarkdownBody>
                  </div>
                </div>
              ))}
            </div>
          )}
          {request.method === "input" && (
            authorizationUrl && (
              <div style={{ marginBottom: 10 }}>
                <a
                  href={authorizationUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{
                    display: "inline-flex",
                    maxWidth: "100%",
                    alignItems: "center",
                    gap: 7,
                    padding: "7px 10px",
                    border: "var(--hairline) solid color-mix(in srgb, var(--accent) 42%, transparent)",
                    borderRadius: "var(--radius-md)",
                    background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                    color: "var(--accent)",
                    fontSize: "var(--fs-caption)",
                    fontWeight: "var(--fw-semibold)",
                    textDecoration: "none",
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M15 3h6v6" />
                    <path d="M10 14 21 3" />
                    <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
                  </svg>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t("mcp.openAuthorization")}
                  </span>
                </a>
              </div>
            )
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isImeComposing(e)) submitValue();
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: "var(--radius-md)",
                border: "var(--hairline) solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: "var(--fs-body)",
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !isImeComposing(e)) submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: "var(--radius-md)",
                border: "var(--hairline) solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: "var(--fs-body)",
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div style={{ flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "var(--hairline) solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            autoFocus={request.method === "confirm" || (request.method === "select" && request.options.length === 0)}
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: "var(--radius-sm)",
              border: "var(--hairline) solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: "var(--radius-sm)",
                border: "var(--hairline) solid var(--accent)",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: "var(--radius-sm)",
                border: "var(--hairline) solid var(--accent)",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
          ) : null}
        </div>
      </div>
      )}
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function ExtensionCustomPanel({
  request,
  waitingCount,
  onInput,
}: {
  request: ExtensionCustomRequest;
  /** Further custom panels queued behind this one; each opens after this one closes. */
  waitingCount: number;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const displayLines = normalizeCustomPanelLines(request.lines);
  const summary = displayLines.find((line) => line.trim())?.trim();

  useEffect(() => {
    if (!collapsed) inputRef.current?.focus();
  }, [collapsed]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        bottom: "var(--chat-composer-inset, 0px)",
        zIndex: 95,
        display: "flex",
        alignItems: collapsed ? "flex-start" : "center",
        justifyContent: "center",
        padding: 20,
        pointerEvents: "none",
      }}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "min(920px, 100%)",
            width: "100%",
            padding: "10px 12px",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-md)",
            background: "var(--bg)",
            boxShadow: "var(--shadow-popover)",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: "var(--fs-micro)", fontWeight: "var(--fw-semibold)", color: "var(--accent)", flexShrink: 0 }}>
            {t("chat.extensionPending")}
          </span>
          <span style={{ fontSize: "var(--fs-body)", fontWeight: "var(--fw-semibold)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {t("chat.extensionPanel")}
          </span>
          {summary && (
            <span style={{ fontSize: "var(--fs-caption)", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%", flexShrink: 1 }}>
              {summary}
            </span>
          )}
          <ExtensionWaitingCount count={waitingCount} />
          <span style={{ fontSize: "var(--fs-caption)", color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        role="dialog"
        aria-label={t("chat.extensionPanel")}
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          pointerEvents: "auto",
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-md)",
          background: "var(--bg)",
          boxShadow: "var(--shadow-dialog)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || isImeComposing(event)) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || isImeComposing(event)) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "var(--hairline) solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: "var(--fs-body)", fontWeight: "var(--fw-semibold)" }}>{t("chat.extensionPanel")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ExtensionWaitingCount count={waitingCount} />
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-expanded={true}
              title={t("chat.extensionCollapse")}
              aria-label={t("chat.extensionCollapse")}
              style={{
                display: "grid",
                placeItems: "center",
                width: 28,
                height: 28,
                borderRadius: "var(--radius-sm)",
                border: "var(--hairline) solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
            <button
              onClick={() => onInput(request, "\x03")}
              style={{
                padding: "5px 9px",
                borderRadius: "var(--radius-sm)",
                border: "var(--hairline) solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: "var(--fs-caption)",
              }}
            >
               {t("chat.close")}
            </button>
          </div>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            minHeight: 0,
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-body)",
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          <AnsiText text={displayLines.join("\n")} />
        </pre>
      </div>
      )}
    </div>
  );
}

// The reply being streamed: the one part of the chat a chunk re-renders.
const StreamingReply = memo(function StreamingReply({ store, onCommit, toolResults, modelNames, cwd, onOpenFile, onOpenSession }: {
  store: StreamingStore;
  /** Runs after each chunk is in the DOM. */
  onCommit: () => void;
  toolResults: Map<string, ToolResultMessage>;
  modelNames: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const message = useStreamingSelector(store, selectStreamingMessage);
  useLayoutEffect(onCommit, [message, onCommit]);
  if (!message) return null;
  return <MessageView message={message} toolResults={toolResults} isStreaming modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} onOpenSession={onOpenSession} />;
});

