/**
 * Realtime abstraction (Prompt 00 §A / 00B §D): the UI subscribes to
 * canonical events through this seam; the transport (SSE today, WebSocket
 * later) is swappable without touching views.
 *
 * Prompt 00B §D: NO reusable session tokens in URLs. Browser SSE rides the
 * HttpOnly session cookie (sent automatically same-origin, or with
 * credentials for the configured cross-origin API).
 */

export interface RealtimeSubscription {
  close(): void;
}

export interface RealtimeTransport {
  /** Invokes onEvent for every authoritative event after `sinceSeq`. */
  subscribe(
    channel: "org-events",
    sinceSeq: number,
    onEvent: (frame: { seq: number; event: unknown }) => void,
    onError: (error: Error) => void,
  ): RealtimeSubscription;
}

export class SseRealtimeTransport implements RealtimeTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly crossOrigin: boolean,
  ) {}

  subscribe(
    channel: "org-events",
    sinceSeq: number,
    onEvent: (frame: { seq: number; event: unknown }) => void,
    onError: (error: Error) => void,
  ): RealtimeSubscription {
    // Authentication is implicit via cookie — never a query parameter.
    const url = `${this.baseUrl}/api/streams/${channel}?sinceSeq=${sinceSeq}`;
    const source = new EventSource(url, { withCredentials: this.crossOrigin });
    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data) as { seq: number; event: unknown });
      } catch {
        onError(new Error("malformed realtime frame"));
      }
    };
    source.onerror = () => onError(new Error("realtime stream disconnected"));
    return {
      close: () => source.close(),
    };
  }
}
