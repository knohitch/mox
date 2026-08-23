/**
 * Realtime abstraction (Prompt 00 §A): the UI subscribes to canonical
 * events through this seam; the transport (SSE today, WebSocket later)
 * is swappable without touching views.
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

/** SSE implementation over the control plane's durable event replay. */
export class SseRealtimeTransport implements RealtimeTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly tokenProvider: () => Promise<string>,
  ) {}

  subscribe(
    channel: "org-events",
    sinceSeq: number,
    onEvent: (frame: { seq: number; event: unknown }) => void,
    onError: (error: Error) => void,
  ): RealtimeSubscription {
    let closed = false;
    let source: EventSource | undefined;
    void this.tokenProvider()
      .then((token) => {
        if (closed) return;
        // EventSource cannot set headers; the control plane accepts the
        // session token as a query parameter for this read-only stream.
        const url = `${this.baseUrl}/api/streams/${channel}?sinceSeq=${sinceSeq}&token=${encodeURIComponent(token)}`;
        source = new EventSource(url);
        source.onmessage = (message) => {
          try {
            onEvent(JSON.parse(message.data) as { seq: number; event: unknown });
          } catch {
            onError(new Error("malformed realtime frame"));
          }
        };
        source.onerror = () => onError(new Error("realtime stream disconnected"));
      })
      .catch(onError);
    return {
      close: () => {
        closed = true;
        source?.close();
      },
    };
  }
}
