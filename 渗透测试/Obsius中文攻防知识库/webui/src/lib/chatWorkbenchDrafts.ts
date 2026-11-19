export type ChatWorkbenchState = {
  pid: string
  agentId: string
  tid: string | null
  drafts: Record<string, string>
  selectedThreads: Record<string, string | null>
}

export function chatDraftKey(agentId: string, tid: string | null): string {
  return JSON.stringify([agentId, tid])
}

export function createChatWorkbenchState(pid: string, agentId: string): ChatWorkbenchState {
  return { pid, agentId, tid: null, drafts: {}, selectedThreads: {} }
}

export function chatWorkbenchStateForProject(
  state: ChatWorkbenchState | null | undefined,
  pid: string,
  fallbackAgentId: string,
): ChatWorkbenchState {
  return state?.pid === pid ? state : createChatWorkbenchState(pid, fallbackAgentId)
}

export function chatWorkbenchDraft(
  state: ChatWorkbenchState,
  agentId: string,
  tid: string | null,
): string {
  return state.drafts[chatDraftKey(agentId, tid)] ?? ""
}

export function saveChatWorkbenchDraft(
  state: ChatWorkbenchState,
  agentId: string,
  tid: string | null,
  input: string,
): ChatWorkbenchState {
  return {
    ...state,
    agentId,
    tid,
    drafts: { ...state.drafts, [chatDraftKey(agentId, tid)]: input },
    selectedThreads: { ...state.selectedThreads, [agentId]: tid },
  }
}

export function selectChatWorkbenchThread(
  state: ChatWorkbenchState,
  agentId: string,
  tid: string | null,
): ChatWorkbenchState {
  return {
    ...state,
    agentId,
    tid,
    selectedThreads: { ...state.selectedThreads, [agentId]: tid },
  }
}

export function selectChatWorkbenchAgent(
  state: ChatWorkbenchState,
  agentId: string,
): ChatWorkbenchState {
  const tid = state.selectedThreads[agentId] ?? null
  return { ...state, agentId, tid }
}
