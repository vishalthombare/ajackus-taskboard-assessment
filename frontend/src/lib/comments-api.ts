import { apiFetch } from "@/lib/api-client";
import type { CommentPage, TaskComment } from "@/types";

export function getComments(taskId: string, cursor: string | null, signal?: AbortSignal) {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : "";
  return apiFetch<CommentPage>(`/api/tasks/${taskId}/comments${query}`, { signal });
}

export function postComment(taskId: string, body: string) {
  return apiFetch<{ comment: TaskComment }>(`/api/tasks/${taskId}/comments`, {
    method: "POST", body: JSON.stringify({ body }),
  });
}
