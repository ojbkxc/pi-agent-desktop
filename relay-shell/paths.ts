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
 * protocol-relative, backslashes, encoded or literal traversal — falls back
 * to "/", and so does a first segment that names a file rather than a route.
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
  // Encoded bytes in the path portion never name an app route — routes and
  // session ids are plain text, and Next decodes the pathname before matching,
  // so "%61pi" would arrive as "/api". Only query values (a leafId, a search
  // term) legitimately carry %XX, so the check stops at the first "?".
  // Encoded separators, encoded dots, and traversal never name an app page
  // either; normalizing them away would only make the check lie about what
  // gets framed.
  const queryStart = path.indexOf("?");
  const pathPart = queryStart === -1 ? path : path.slice(0, queryStart);
  if (/%[0-9a-f]{2}/i.test(pathPart)) return "/";
  if (/(^|\/)\.\.?(\/|$)/.test(pathPart)) return "/";
  const first = pathPart.slice(1).split("/", 1)[0] ?? "";
  if (first.includes(".") || FORBIDDEN_FIRST_SEGMENTS.has(first.toLowerCase())) return "/";
  return path;
}
