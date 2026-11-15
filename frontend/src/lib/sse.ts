import { apiUrl } from "../api/client";

export interface SseEvent {
  event: "start" | "token" | "sources" | "done" | "error" | string;
  data: Record<string, unknown>;
}

export class AssistantError extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false) {
    super(message);
  }
}

/** POST to our backend's assistant proxy and yield SSE events as they arrive.
 * Errors before the stream starts come back as JSON {code, message, retryable}. */
export async function* streamAssistant(body: { message: string; session_id: string; context?: string }, signal: AbortSignal): AsyncGenerator<SseEvent> {
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/assistant/chat/stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new AssistantError(0, "network", "Cannot reach the COSMIC backend.", true);
  }
  if (!res.ok || !res.body) {
    let j: { code?: string; message?: string; retryable?: boolean } = {};
    try {
      j = await res.json();
    } catch {
      /* not JSON */
    }
    throw new AssistantError(res.status, j.code ?? "http_error", j.message ?? `Assistant error (HTTP ${res.status})`, !!j.retryable);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event: string | null = null;
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue; // keepalive comment
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!event) continue;
      try {
        yield { event, data: data ? JSON.parse(data) : {} };
      } catch {
        yield { event, data: {} };
      }
    }
  }
}
