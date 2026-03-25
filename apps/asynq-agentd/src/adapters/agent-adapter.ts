import type { ActivityPayload, SessionRecord, TaskRecord } from "../domain.ts";

export interface AdapterHooks {
  onEvent: (payload: ActivityPayload) => void;
  onSessionPatch: (patch: Record<string, unknown>) => void;
  onTerminalData: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface AgentAdapter {
  readonly name: string;
  runTask(task: TaskRecord, session: SessionRecord, hooks: AdapterHooks): Promise<void>;
  appendToConversation?(
    conversationId: string,
    prompt: string,
    options?: {
      projectPath?: string;
      modelPreference?: string;
    },
  ): Promise<void>;
  canResumeTask?(task: TaskRecord, session: SessionRecord): boolean;
  writeTerminalInput?(sessionId: string, input: string): void;
  resizeTerminal?(sessionId: string, cols: number, rows: number): void;
  stopSession?(sessionId: string): void;
}
