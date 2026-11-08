/**
 * Which app paths the shell will frame when asked from outside (a link's
 * ?path=, a notification). App pages are allowed — sessions, files, the
 * scheduled page — so a notification can land on the item it announces. The
 * address is attacker-chosen, so anything that would run a GET with the
 * owner's authority is refused outright: /api/** (the desktop's own
 * Sec-Fetch-Site check never sees a tunneled request, so framing
 * /api/sessions/<id>/export would bypass its user-initiated guard), the
 * login route, and the shell's own files (framing /__shell/ would recurse
 * into the shell itself). Anything that is not a plain root-relative path —
 * protocol-relative, backslashes, control characters, traversal — falls back
 * to "/", and so does a first segment that names a file rather than a route.
 *
 * Percent-encoding is judged canonicalize-then-validate: file deep links
 * legitimately carry %XX (spaces, CJK, "#" and "%" in names), so the check
 * runs on the decoded path — the same form Next routes on — and the return
 * value keeps the original encoding.
 */
const FORBIDDEN_FIRST_SEGMENTS = new Set(["api", "login", "__shell"]);

export function safeAppPath(path: unknown): string {
  if (typeof path !== "string" || path === "" || path.includes("\\")) return "/";
  // WHATWG URL parsing strips ASCII tab/LF/CR from anywhere in the input, so
  // "/ap\ni/…" reaches the server as "/api/…" — the exact framed-GET
  // escalation this function exists to prevent (iframe src, 302 redirects and
  // SW fetches all go through URL parsing). Any other C0 control or DEL is
  // equally foreign to a plain route path. Never try to normalize: a guard
  // that guesses what the browser will request eventually guesses wrong.
  if (/[\u0000-\u001f\u007f]/.test(path)) return "/";
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  // Decode once, exactly like the server's router does, then judge the decoded
  // form. The query (everything from the first literal "?") is returned as-is
  // and never judged — a leafId or a search term may encode freely.
  const queryStart = path.indexOf("?");
  const rawPathPart = queryStart === -1 ? path : path.slice(0, queryStart);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathPart);
  } catch {
    // Malformed escapes: nothing honest decodes from it.
    return "/";
  }
  // Decoding can smuggle a new "?" (/%61pi%3fx → /api?x); the server splits
  // the decoded path the same way, so re-split here before judging.
  const decodedQueryStart = decoded.indexOf("?");
  const effective = decodedQueryStart === -1 ? decoded : decoded.slice(0, decodedQueryStart);
  // Every judgement re-runs on the decoded, query-stripped form: literal C0
  // (from %0a and friends), backslashes, protocol-relative, traversal
  // segments, and the first-segment file/forbidden checks. Bytes that are
  // double-encoded survive one decode as "%xx" — no route segment contains
  // one, and the server's single decode agrees, so nothing is smuggled.
  if (/[\u0000-\u001f\u007f]/.test(effective) || effective.includes("\\")) return "/";
  if (!effective.startsWith("/") || effective.startsWith("//")) return "/";
  if (/(^|\/)\.\.?(\/|$)/.test(effective)) return "/";
  const first = effective.slice(1).split("/", 1)[0] ?? "";
  if (first.includes(".") || FORBIDDEN_FIRST_SEGMENTS.has(first.toLowerCase())) return "/";
  return path;
}
