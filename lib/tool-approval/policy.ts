/**
 * 命令审批（对齐 alma.now 的「批准命令」）的纯策略层：三档模式 + 危险命令规则表。
 *
 * 这里没有任何 IO —— 设置读写（lib/tool-approval/settings.ts）、tool_call 接线
 * （lib/tool-approval/extension.ts）与设置页都只依赖本文件的纯函数。规则匹配刻意
 * **保守**：宁可漏报（由 `all` 档兜底）也不误报，否则每次 grep / echo 都弹窗，用户
 * 很快就关掉这个功能。被拦截的只有真正会不可逆地毁数据的命令。
 *
 * 默认 `off`：不改变既有行为，用户显式开启才生效。
 */

export const APPROVAL_MODES = ["off", "dangerous", "all"] as const;

/** off：不干预；dangerous：只拦危险规则命中的命令；all：每条 shell 命令都先确认。 */
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

/** tool_call 事件里本模块真正需要的部分（SDK 的 ToolCallEvent 结构上可赋值给它）。 */
export interface ApprovalToolCall {
  toolName: string;
  input?: unknown;
}

export interface ApprovalDecision {
  required: boolean;
  /** 命中的规则 id（`all` 档为 "all"）；不要求确认时缺省。 */
  rule?: string;
  /** 确认框正文：规则名 + 命令内容。不要求确认时为空串。 */
  summary: string;
}

/** `all` 档的规则 id。 */
export const APPROVAL_ALL_RULE_ID = "all";

/** `all` 档在确认框里展示的规则名。 */
export const APPROVAL_ALL_RULE_LABEL = "所有 Shell 命令";

/**
 * `bash_background` 也在其中：它同样执行任意 shell 命令，只是不阻塞循环。
 * 漏掉它等于给了一条绕过审批的后门（`all` 档也会放过）。
 */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell", "bash_background"]);

/** 命令超过这个长度只截断展示，不影响匹配（匹配始终看完整命令）。 */
export const COMMAND_EXCERPT_MAX = 1200;

/** 分段：管道、命令分隔、子 shell、命令替换与换行。 */
const SEGMENT_SEPARATORS = /[;&|()`\n]+/;

/**
 * 把命令切成独立命令段，每段再切成词；词的引号只做首尾剥除。
 *
 * 分隔符包含管道、子 shell 与反引号：`echo $(rm -rf x)` 里的内部命令同样要被看见
 * （codemode 的内层 bash 走同一个 hook，命令文本也可能带替换语法）。引号不整体解析
 * 是刻意的：`bash -c "rm -rf /"` 这种写法反而能识别到 `rm`，代价是引号内真正的
 * 分隔符不展开 —— 漏报可以接受（`all` 档兜底），误报才是体验杀手。
 */
function wordsOf(command: string): string[][] {
  return command
    .split(SEGMENT_SEPARATORS)
    .map((segment) => segment
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/^["'`]+|["'`]+$/g, ""))
      .filter(Boolean))
    .filter((words) => words.length > 0);
}

/** `/usr/bin/rm`、`rm.exe`、`rm` 都归一成 `rm`（小写）。 */
function commandName(word: string): string {
  const bare = word.replace(/\.exe$/i, "");
  const base = bare.split(/[\\/]/).pop() ?? bare;
  return base.toLowerCase();
}

/** 命令前可以出现的包装词（`sudo rm -rf` 里的 rm 仍是命令头）。 */
const PREFIX_WORDS: ReadonlySet<string> = new Set(["sudo", "doas", "nohup", "time", "exec", "command", "env"]);

/** 会「执行后面命令」的词：`xargs rm -rf`、`find … -exec rm -rf {} +`。 */
const EXEC_PREFIX_WORDS: ReadonlySet<string> = new Set(["xargs", "-exec", "-execdir", "exec"]);

/** 外壳解释器；它们的 `-c` / `-Command` 后的字符串才是一条命令。 */
const SHELL_WRAPPER_HEADS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "pwsh", "powershell", "cmd"]);

const SHELL_EXEC_FLAGS: ReadonlySet<string> = new Set(["-c", "-command"]);

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/** 命令段里真正的第一个命令的下标（跳过前缀词与 `VAR=value` 赋值）；没有命令时 -1。 */
function firstCommandIndex(words: string[]): number {
  for (let index = 0; index < words.length; index++) {
    if (PREFIX_WORDS.has(words[index]) || isAssignment(words[index])) continue;
    return index;
  }
  return -1;
}

/**
 * `words[index]` 是否是真正会被执行的命令，不是被 grep/echo 引用的字符串。
 *
 * 三种情况算执行：命令头（跳过 sudo/env/变量赋值）、紧跟 xargs / `-exec`、以及
 * `bash -c "…"` / `powershell -Command "…"` 的 -c/-Command 之后（-c 只在外壳解释器
 * 之后才算，于是 `grep -c "rm -rf" file` 不会被误报）。
 */
function isExecutedAt(words: string[], index: number): boolean {
  const head = firstCommandIndex(words);
  if (head === index) return true;
  const previous = index > 0 ? words[index - 1].toLowerCase() : "";
  if (EXEC_PREFIX_WORDS.has(previous)) return true;
  // `xargs -0 rm -rf`：xargs 后面的词都可能是被执行的命令，选项夹在中间。
  if (head >= 0 && head !== index && commandName(words[head]) === "xargs") return true;
  return SHELL_EXEC_FLAGS.has(previous)
    && head >= 0
    && SHELL_WRAPPER_HEADS.has(commandName(words[head]));
}

/** 命令里每个「会被执行」的命令段，连同它在该段中的下标。 */
function executedCommands(command: string): Array<{ words: string[]; index: number; name: string }> {
  const found: Array<{ words: string[]; index: number; name: string }> = [];
  for (const words of wordsOf(command)) {
    words.forEach((word, index) => {
      if (isExecutedAt(words, index)) found.push({ words, index, name: commandName(word) });
    });
  }
  return found;
}

/** 该段里某个被执行的命令之后的参数。 */
function argsAfter(words: string[], index: number): string[] {
  return words.slice(index + 1);
}

/** 是否存在一个被执行、名为 `name` 的命令，并且 `predicate` 接受它的参数。 */
function hasExecuted(command: string, name: string, predicate: (args: string[]) => boolean): boolean {
  return executedCommands(command)
    .some((entry) => entry.name === name && predicate(argsAfter(entry.words, entry.index)));
}

/** `rm` 且选项里同时有递归(r/R)与强制(f)（`-rf`、`-fr`、`-r -f`、`--recursive --force`）。 */
function matchesRmRecursiveForce(command: string): boolean {
  return hasExecuted(command, "rm", (args) => {
    let recursive = false;
    let force = false;
    for (const arg of args) {
      if (arg === "--") break; // 之后是操作数，按 argv 规则不再有选项
      if (arg === "--recursive") recursive = true;
      else if (arg === "--force") force = true;
      else if (/^-[A-Za-z]+$/.test(arg)) {
        const letters = arg.slice(1);
        if (/[rR]/.test(letters)) recursive = true;
        if (/f/.test(letters)) force = true;
      }
    }
    return recursive && force;
  });
}

/** PowerShell `Remove-Item -Recurse -Force`（含 `-Recurse:$true` 这类写法）。 */
function matchesRemoveItemRecursiveForce(command: string): boolean {
  return hasExecuted(command, "remove-item", (args) => {
    const lowered = args.map((arg) => arg.toLowerCase());
    return lowered.some((arg) => arg.startsWith("-recurse"))
      && lowered.some((arg) => arg.startsWith("-force"));
  });
}

/** `git push --force` / `-f` / `--force-with-lease` / `+refspec`。 */
function matchesGitPushForce(command: string): boolean {
  return hasExecuted(command, "git", (args) => {
    const push = args.indexOf("push");
    if (push < 0) return false;
    return args.slice(push + 1).some((arg) =>
      arg === "-f" || arg === "--force" || arg.startsWith("--force-") || /^\+[^\s-]/.test(arg),
    );
  });
}

/** `git reset --hard`。 */
function matchesGitResetHard(command: string): boolean {
  return hasExecuted(command, "git", (args) => {
    const reset = args.indexOf("reset");
    return reset >= 0 && args.slice(reset + 1).includes("--hard");
  });
}

/** `mkfs` / `mkfs.ext4` / `mkfs.xfs`。 */
function matchesMkfs(command: string): boolean {
  return executedCommands(command).some((entry) => /^mkfs(\.[a-z0-9]+)?$/.test(entry.name));
}

/** `dd if=…`（原始磁盘写入）。 */
function matchesDdIf(command: string): boolean {
  return hasExecuted(command, "dd", (args) => args.some((arg) => arg.startsWith("if=")));
}

/** `curl … | sh` / `wget … | bash`，中间的管道段不限。 */
function matchesDownloadPipeShell(command: string, downloader: string): boolean {
  const pattern = new RegExp(
    `(^|[\\s;&|(\\n])${downloader}\\b[^\\n]*\\|\\s*(?:sudo\\s+)?(?:[^\\s|]*[\\\\/])?(?:sh|bash|zsh|dash)\\b`,
    "i",
  );
  return pattern.test(command);
}

/** `chmod` 带递归选项且模式是 777/0777。 */
function matchesChmodRecursive777(command: string): boolean {
  return hasExecuted(command, "chmod", (args) => {
    const recursive = args.some((arg) => arg === "-R" || arg === "-r" || arg === "--recursive");
    const worldWritable = args.some((arg) => /^0?777$/.test(arg));
    return recursive && worldWritable;
  });
}

/** `shutdown` / `reboot` / `poweroff`（Windows 的 shutdown.exe 同样命中）。 */
function matchesPowerCommand(command: string): boolean {
  return executedCommands(command).some((entry) =>
    entry.name === "shutdown" || entry.name === "reboot" || entry.name === "poweroff",
  );
}

/** `diskpart`。 */
function matchesDiskpart(command: string): boolean {
  return executedCommands(command).some((entry) => entry.name === "diskpart");
}

/** `Format-Volume`。 */
function matchesFormatVolume(command: string): boolean {
  return executedCommands(command).some((entry) => entry.name === "format-volume");
}

/** `taskkill /F`（强制结束进程）。 */
function matchesTaskkillForce(command: string): boolean {
  return hasExecuted(command, "taskkill", (args) => args.some((arg) => /^[/-]f$/i.test(arg)));
}

export interface DangerRule {
  /** 稳定 id：测试、日志与设置页的文案键用（`approval.rule.<id>`）。 */
  id: string;
  /** 确认框里展示的规则名。 */
  label: string;
  /** 是否命中整条命令（完整命令文本，不是它的截断版）。 */
  test: (command: string) => boolean;
}

/**
 * 危险命令规则表。顺序即优先级：一条命令命中多条时取第一条（只影响展示的规则名）。
 * 加规则的门槛：无提示执行会造成不可逆的数据/系统损坏；普通的时间损失不算。
 */
export const DANGEROUS_RULES: readonly DangerRule[] = [
  {
    id: "rm-recursive-force",
    label: "递归强制删除（rm -rf）",
    test: matchesRmRecursiveForce,
  },
  {
    id: "remove-item-recursive-force",
    label: "递归强制删除（Remove-Item -Recurse -Force）",
    test: matchesRemoveItemRecursiveForce,
  },
  {
    id: "git-push-force",
    label: "强制推送（git push --force / -f）",
    test: matchesGitPushForce,
  },
  {
    id: "git-reset-hard",
    label: "硬重置（git reset --hard）",
    test: matchesGitResetHard,
  },
  {
    id: "drop-table",
    label: "删除数据库表（DROP TABLE）",
    test: (command) => /\bdrop\s+table\b/i.test(command),
  },
  {
    id: "truncate-table",
    label: "清空数据库表（TRUNCATE TABLE）",
    test: (command) => /\btruncate\s+table\b/i.test(command),
  },
  {
    id: "mkfs",
    label: "格式化文件系统（mkfs）",
    test: matchesMkfs,
  },
  {
    id: "dd-if",
    label: "原始磁盘写入（dd if=）",
    test: matchesDdIf,
  },
  {
    id: "curl-pipe-shell",
    label: "下载脚本并直接执行（curl | sh）",
    test: (command) => matchesDownloadPipeShell(command, "curl"),
  },
  {
    id: "wget-pipe-shell",
    label: "下载脚本并直接执行（wget | sh）",
    test: (command) => matchesDownloadPipeShell(command, "wget"),
  },
  {
    id: "chmod-recursive-777",
    label: "递归开放全部权限（chmod -R 777）",
    test: matchesChmodRecursive777,
  },
  {
    id: "power",
    label: "关机／重启（shutdown、reboot、poweroff）",
    test: matchesPowerCommand,
  },
  {
    id: "diskpart",
    label: "磁盘分区操作（diskpart）",
    test: matchesDiskpart,
  },
  {
    id: "format-volume",
    label: "格式化卷（Format-Volume）",
    test: matchesFormatVolume,
  },
  {
    id: "taskkill-force",
    label: "强制结束进程（taskkill /F）",
    test: matchesTaskkillForce,
  },
];

/** 命中的第一条危险规则；命令为空或未命中时 undefined。 */
export function findDangerousRule(command: string): DangerRule | undefined {
  if (!command.trim()) return undefined;
  return DANGEROUS_RULES.find((rule) => rule.test(command));
}

function commandOf(event: ApprovalToolCall): string {
  const input = event.input;
  if (input !== null && typeof input === "object") {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string") return command;
  }
  return "";
}

/** 确认框正文：规则名 + 完整命令的截断展示 + 批准/拒绝的含义。 */
export function approvalSummary(ruleLabel: string, command: string): string {
  const trimmed = command.trim() || "（未能读取命令内容）";
  const excerpt = trimmed.length > COMMAND_EXCERPT_MAX
    ? `${trimmed.slice(0, COMMAND_EXCERPT_MAX - 1)}…`
    : trimmed;
  return [
    `规则：${ruleLabel}`,
    "",
    "```",
    excerpt,
    "```",
    "",
    "批准后该命令会执行；拒绝后它不会运行，模型会收到拒绝原因。",
  ].join("\n");
}

/**
 * 核心判定：这个工具调用是否必须先经用户确认。
 *
 * - 只有 bash / powershell 参与；文件类工具与自定义工具一律放行。
 * - `off`（默认）与非法值放行 —— 设置文件损坏不能让审批器「挂上」。
 * - `all` 对每条 shell 命令都要求确认；`dangerous` 只要求规则命中的。
 * - 命令读不出来（input 形状异常）时 `dangerous` 放行，`all` 仍要求确认。
 */
export function requiresApproval(mode: ApprovalMode, event: ApprovalToolCall): ApprovalDecision {
  if (!SHELL_TOOLS.has(event?.toolName ?? "")) return { required: false, summary: "" };
  if (!isApprovalMode(mode) || mode === "off") return { required: false, summary: "" };

  const command = commandOf(event);
  if (mode === "all") {
    return {
      required: true,
      rule: APPROVAL_ALL_RULE_ID,
      summary: approvalSummary(APPROVAL_ALL_RULE_LABEL, command),
    };
  }

  const rule = findDangerousRule(command);
  if (!rule) return { required: false, summary: "" };
  return { required: true, rule: rule.id, summary: approvalSummary(rule.label, command) };
}