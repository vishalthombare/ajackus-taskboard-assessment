import { apiFetch } from "@/lib/api-client";

export type ActivityChange = {
  from: string | number | null;
  to: string | number | null;
  fromName?: string | null;
  toName?: string | null;
};

export type ProjectActivity = {
  id: string;
  actor: { id: string; name: string };
  task: { id: string; title: string };
  eventType: "task_created" | "task_updated" | "comment_added";
  body: string | null;
  changes: Record<string, ActivityChange>;
  createdAt: string;
};

export type ActivityPage = { activity: ProjectActivity[]; nextCursor: string | null };

export const activityQueryKey = (userId: string | undefined, projectId: string) =>
  ["activity", userId, projectId] as const;

export function getActivity(projectId: string, cursor: string | null, signal?: AbortSignal) {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : "";
  return apiFetch<ActivityPage>(`/api/projects/${projectId}/activity${query}`, { signal });
}
