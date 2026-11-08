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
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  // Encoded separators, encoded dots, and traversal never name an app page;
  // normalizing them away would only make the check lie about what gets framed.
  if (/%2f|%2e/i.test(path) || /(^|\/)\.\.?(\/|$)/.test(path)) return "/";
  const first = path.slice(1).split(/[/?]/, 1)[0] ?? "";
  if (first.includes(".") || FORBIDDEN_FIRST_SEGMENTS.has(first.toLowerCase())) return "/";
  return path;
}
