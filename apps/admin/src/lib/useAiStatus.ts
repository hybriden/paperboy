import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";

export const AI_OFF_HINT = "AI is off — add an Anthropic API key in Settings → AI.";

/** Whether a real AI provider is configured. undefined while loading. */
export function useAiEnabled(): boolean | undefined {
  const q = useQuery({
    queryKey: ["ai-status"],
    queryFn: ({ signal }) => api.aiStatus(signal),
    staleTime: 5 * 60_000,
  });
  return q.data?.enabled;
}
