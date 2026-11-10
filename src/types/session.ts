export type AIRequestStatus = 'RUNNING' | 'COMPLETED' | 'INTERRUPTED' | 'FAILED';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  requestId?: string;
  requestStatus?: AIRequestStatus;
  finishReason?: string;
  error?: string;
  taskOutcome?: 'full' | 'degraded' | 'failed';
  reasonCodes?: string[];
  /** Local protocol context for replay; never rendered or sent to the webview. */
  modelContext?: { baseUrl: string; model: string; content: unknown[] };
}

export interface FileState {
  filepath: string;
  content: string;
}

export interface ConversationSnapshot {
  conversationIndex: number;
  timestamp: string;
  files: FileState[];
}

export interface Session {
  sessionId: string;
  title: string;
  workspaceDirectory: string;
  dateCreated: string;
  dateModified: string;
  history: ChatMessage[];
  snapshots: ConversationSnapshot[];
  historySummary?: HistorySummary;
}

/** Derived context only; the original session history remains available. */
export interface HistorySummary {
  content: string;
  coveredMessages: number;
  prefixHash: string;
}

export interface SessionMetadata {
  sessionId: string;
  title: string;
  workspaceDirectory: string;
  dateCreated: string;
  messageCount: number;
}
