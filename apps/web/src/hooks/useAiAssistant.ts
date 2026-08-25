import { useMutation } from "@tanstack/react-query";
import type { AskAiAssistantRequest, AskAiAssistantResponse } from "@luma/shared";
import { api } from "../lib/apiClient";

export function useAskAiAssistant() {
  return useMutation({
    mutationFn: (input: AskAiAssistantRequest) => api.post<AskAiAssistantResponse>("/api/app/ai-assistant/ask", input),
  });
}
