import type { ActivityPayload, SessionRecord } from "../domain.ts";

export interface LiveEvent {
  kind: "activity" | "session" | "summary";
  session_id: string;
  created_at: string;
  payload:
    | ActivityPayload
    | { state: SessionRecord["state"]; adapter: string }
    | { entity_type: "session" | "recent_work"; entity_id: string; scope: "session_card" | "continue_card" | "approval_review"; provider: string };
}

type Subscriber = {
  sessionId?: string;
  listener: (event: LiveEvent) => void;
};

export class EventStreamService {
  private readonly subscribers = new Set<Subscriber>();

  publish(event: LiveEvent): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.sessionId && subscriber.sessionId !== event.session_id) {
        continue;
      }

      subscriber.listener(event);
    }
  }

  subscribe(listener: (event: LiveEvent) => void, sessionId?: string): () => void {
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
