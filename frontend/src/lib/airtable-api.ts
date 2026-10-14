import { apiFetch } from "@/lib/api-client";

export type ExportResult = {
  total: number;
  exported: number;
  created: number;
  updated: number;
  failed: number;
  failures: { taskId: string; title?: string; code: string; message: string; retryable: boolean }[];
  baseUrl?: string;
  error?: string;
};

export function exportProject(projectId: string) {
  return apiFetch<ExportResult>(`/api/projects/${projectId}/export`, { method: "POST" });
}
