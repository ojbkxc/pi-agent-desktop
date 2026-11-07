import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  RequestBodyTooLargeError,
  readRequestBytesWithinLimit,
} from "@/lib/bounded-form-data";
import {
  CHAT_ATTACHMENT_EXTRACT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_FILE_BYTES,
} from "@/lib/chat-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Plain text of a Word document attached to a chat. The browser sends the file body as-is;
 * nothing is written to disk and no path is involved, so the chat's "no file access" holds.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    // Bounded read: a chunked request has no Content-Length, so the declared
    // header alone would let an unbounded body be buffered in full.
    const bytes = await readRequestBytesWithinLimit(req, CHAT_ATTACHMENT_EXTRACT_MAX_BYTES);
    const buffer = Buffer.from(bytes);
    if (buffer.length === 0) {
      return NextResponse.json({ error: "not-text" }, { status: 400 });
    }
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer });
    const text = value.replace(/\r\n?/g, "\n").trim();
    if (!text) return NextResponse.json({ error: "not-text" }, { status: 422 });
    if (Buffer.byteLength(text, "utf8") > CHAT_ATTACHMENT_MAX_FILE_BYTES) {
      return NextResponse.json({ error: "too-large" }, { status: 413 });
    }
    return NextResponse.json({ text });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "too-large" }, { status: 413 });
    }
    return NextResponse.json({ error: "not-text" }, { status: 422 });
  }
}
