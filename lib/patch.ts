export type SplitDiffCellType = "context" | "removed" | "added" | "empty";

export interface SplitDiffCell {
  lineNo: number | null;
  text: string;
  type: SplitDiffCellType;
}

export type SplitDiffRow =
  | { type: "hunk"; text: string }
  // Unchanged lines a diff leaves out between two hunks. count is null when the
  // diff carries no line numbers to compute it from.
  | { type: "gap"; count: number | null }
  | { type: "line"; left: SplitDiffCell; right: SplitDiffCell };

export type SplitDiffGap = Extract<SplitDiffRow, { type: "gap" }>;

export interface SplitDiffFile {
  oldPath?: string;
  newPath?: string;
  rows: SplitDiffRow[];
}

interface PendingChangeLine {
  lineNo: number;
  text: string;
}

export function parseUnifiedPatch(text: string): SplitDiffFile[] | null {
  const files: SplitDiffFile[] = [];
  let current: SplitDiffFile | null = null;
  let pendingOldPath: string | undefined;
  let oldLineNo = 0;
  let newLineNo = 0;
  // Where the previous hunk in this file ended on both sides, so the gap of
  // unchanged lines it leaves out between hunks can be counted.
  let prevHunkEnd: { old: number; new: number } | null = null;
  // Lines still expected in the current hunk body, from the @@ header counts.
  // While either is positive we are inside a hunk, where a line starting with
  // "--- "/"+++ " is a removed/added content line (e.g. "-- x"/"++ x"), not a
  // file header — checking for headers there splits one file into bogus extras.
  let hunkOldRemaining = 0;
  let hunkNewRemaining = 0;
  let removed: PendingChangeLine[] = [];
  let added: PendingChangeLine[] = [];

  const emptyCell = (): SplitDiffCell => ({ lineNo: null, text: "", type: "empty" });
  const flushChanges = () => {
    if (!current) {
      removed = [];
      added = [];
      return;
    }
    const count = Math.max(removed.length, added.length);
    for (let i = 0; i < count; i++) {
      const left = removed[i]
        ? { lineNo: removed[i].lineNo, text: removed[i].text, type: "removed" as const }
        : emptyCell();
      const right = added[i]
        ? { lineNo: added[i].lineNo, text: added[i].text, type: "added" as const }
        : emptyCell();
      current.rows.push({ type: "line", left, right });
    }
    removed = [];
    added = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const insideHunk = hunkOldRemaining > 0 || hunkNewRemaining > 0;

    // File headers only appear between hunks, never inside a hunk body.
    if (!insideHunk) {
      if (line.startsWith("--- ")) {
        flushChanges();
        pendingOldPath = cleanPatchPath(line.slice(4));
        continue;
      }

      if (line.startsWith("+++ ")) {
        flushChanges();
        current = { oldPath: pendingOldPath, newPath: cleanPatchPath(line.slice(4)), rows: [] };
        files.push(current);
        continue;
      }
    }

    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      if (!current) {
        current = { rows: [] };
        files.push(current);
      }
      flushChanges();
      oldLineNo = Number(hunk[1]);
      newLineNo = Number(hunk[3]);
      hunkOldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      hunkNewRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
      // A side with no lines in the hunk names the line before it ("-5,0").
      const oldStart = hunkOldRemaining === 0 ? oldLineNo + 1 : oldLineNo;
      const newStart = hunkNewRemaining === 0 ? newLineNo + 1 : newLineNo;
      if (prevHunkEnd) {
        const oldGap = oldStart - prevHunkEnd.old;
        const newGap = newStart - prevHunkEnd.new;
        if (oldGap > 0 || newGap > 0) {
          current.rows.push({ type: "gap", count: oldGap === newGap ? oldGap : null });
        }
      }
      prevHunkEnd = { old: oldStart + hunkOldRemaining, new: newStart + hunkNewRemaining };
      current.rows.push({ type: "hunk", text: line });
      continue;
    }

    if (!current) continue;

    if (line.startsWith("\\ ")) {
      flushChanges();
      current.rows.push({ type: "hunk", text: line });
      continue;
    }

    const prefix = line[0];
    const content = line.slice(1);

    if (prefix === " ") {
      flushChanges();
      current.rows.push({
        type: "line",
        left: { lineNo: oldLineNo++, text: content, type: "context" },
        right: { lineNo: newLineNo++, text: content, type: "context" },
      });
      if (hunkOldRemaining > 0) hunkOldRemaining--;
      if (hunkNewRemaining > 0) hunkNewRemaining--;
    } else if (prefix === "-") {
      removed.push({ lineNo: oldLineNo++, text: content });
      if (hunkOldRemaining > 0) hunkOldRemaining--;
    } else if (prefix === "+") {
      added.push({ lineNo: newLineNo++, text: content });
      if (hunkNewRemaining > 0) hunkNewRemaining--;
    } else if (line !== "") {
      flushChanges();
      current.rows.push({ type: "hunk", text: line });
    }
  }

  flushChanges();

  const parsed = files.filter((file) => file.rows.some((row) => row.type === "line"));
  return parsed.length > 0 ? parsed : null;
}

function cleanPatchPath(path: string): string {
  return path.split("\t")[0].trim();
}

/** A gap row's known count as "N unchanged lines" in the UI language. */
export function diffGapLabel(count: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  return count === 1 ? t("diff.unchangedLine") : t("diff.unchangedLines", { count });
}
