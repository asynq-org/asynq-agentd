import type { AsynqAgentdStorage } from "../db/storage.ts";
import type { TerminalChunkRecord } from "../domain.ts";
import { nowIso } from "../utils/time.ts";

type Subscriber = {
  sessionId?: string;
  listener: (event: TerminalChunkRecord) => void;
};

export class TerminalStreamService {
  private readonly subscribers = new Set<Subscriber>();
  private readonly history = new Map<string, TerminalChunkRecord[]>();
  private readonly storage?: AsynqAgentdStorage;
  private readonly maxEventsPerSession: number;

  constructor(storageOrMaxEvents?: AsynqAgentdStorage | number, maxEventsPerSession = 500) {
    if (typeof storageOrMaxEvents === "number") {
      this.storage = undefined;
      this.maxEventsPerSession = storageOrMaxEvents;
      return;
    }

    this.storage = storageOrMaxEvents;
    this.maxEventsPerSession = maxEventsPerSession;
  }

  publish(sessionId: string, stream: "stdin" | "stdout" | "stderr", chunk: string): void {
    const event = this.storage
      ? this.storage.insertTerminalEvent(sessionId, nowIso(), stream, chunk)
      : {
        id: 0,
        session_id: sessionId,
        created_at: nowIso(),
        stream,
        chunk,
      };
    const current = this.history.get(sessionId) ?? [];
    current.push(event);
    if (current.length > this.maxEventsPerSession) {
      current.splice(0, current.length - this.maxEventsPerSession);
    }
    this.history.set(sessionId, current);
    this.storage?.trimTerminalEvents(sessionId, this.maxEventsPerSession);

    for (const subscriber of this.subscribers) {
      if (subscriber.sessionId && subscriber.sessionId !== sessionId) {
        continue;
      }

      subscriber.listener(event);
    }
  }

  list(sessionId: string, limit = 100): TerminalChunkRecord[] {
    const events = this.history.get(sessionId) ?? this.storage?.listTerminalEvents(sessionId, limit) ?? [];
    if (!this.history.has(sessionId) && events.length > 0) {
      this.history.set(sessionId, [...events]);
    }
    if (limit <= 0) {
      return [];
    }

    return events.slice(-limit);
  }

  subscribe(listener: (event: TerminalChunkRecord) => void, sessionId?: string): () => void {
    const subscriber: Subscriber = {
      sessionId,
      listener,
    };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }
}
