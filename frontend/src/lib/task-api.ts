import { apiFetch } from "@/lib/api-client";
import type { ApiProjectDetail, ApiTask } from "@/types";

type TaskResponse = Omit<ApiTask, "projectId" | "assigneeId" | "createdById" | "createdAt" | "updatedAt"> & {
  project_id: string;
  assignee_id: string | null;
  created_by_id: string;
  created_at: string;
  updated_at: string;
};

type ProjectResponse = Omit<ApiProjectDetail, "ownerId" | "createdAt" | "updatedAt" | "tasks"> & {
  owner_id: string;
  created_at: string;
  updated_at: string;
  tasks: TaskResponse[];
};

type TaskInput = Pick<ApiTask, "title"> & Partial<Pick<ApiTask, "description" | "status" | "assigneeId">>;

function mapTask(task: TaskResponse): ApiTask {
  const { project_id, assignee_id, created_by_id, created_at, updated_at, ...rest } = task;
  return {
    ...rest,
    projectId: project_id,
    assigneeId: assignee_id,
    createdById: created_by_id,
    createdAt: created_at,
    updatedAt: updated_at,
  };
}

export async function getProject(projectId: string, options: RequestInit = {}) {
  const { project } = await apiFetch<{ project: ProjectResponse }>(`/api/projects/${projectId}`, options);
  const { owner_id, created_at, updated_at, tasks, ...rest } = project;
  return { project: {
    ...rest,
    ownerId: owner_id,
    createdAt: created_at,
    updatedAt: updated_at,
    tasks: tasks.map(mapTask),
  } satisfies ApiProjectDetail };
}

export async function createTask(projectId: string, input: TaskInput) {
  const { task } = await apiFetch<{ task: TaskResponse }>(`/api/projects/${projectId}/tasks`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return { task: mapTask(task) };
}

export async function updateTask(taskId: string, input: Partial<TaskInput>) {
  const { task } = await apiFetch<{ task: TaskResponse }>(`/api/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return { task: mapTask(task) };
}
