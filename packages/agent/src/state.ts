import { Annotation } from "@langchain/langgraph";
import { messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

export const GraphState = Annotation.Root({
  /**
   * Full conversation history.
   * Uses messagesStateReducer so nodes can remove or replace messages
   * via RemoveMessage (including the REMOVE_ALL_MESSAGES sentinel).
   */
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  sessionId: Annotation<string>(),
  userId: Annotation<string>(),
  systemPrompt: Annotation<string>(),
  /**
   * Consecutive compaction failure counter for the circuit breaker.
   * Reducer is last-write-wins — callers set it explicitly each time.
   */
  compactionCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  /**
   * When true (cron / scheduled tasks), medium/high-risk tools auto-execute
   * without interrupting for human confirmation.
   */
  bypassConfirmation: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
});
