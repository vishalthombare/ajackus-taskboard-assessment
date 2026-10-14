import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ProjectPage from "@/pages/ProjectPage";
import { clearSession, setSession } from "@/lib/api-client";
import { createTask, getProject, updateTask } from "@/lib/task-api";
import { queryClient } from "@/lib/query-client";

const owner = { id: "u1", name: "Owner", email: "owner@example.com" };
const assignee = { id: "u2", name: "Assignee", email: "assignee@example.com" };
const timestamp = "2026-10-14T00:00:00Z";
const initialTask = {
  id: "t1", project_id: "p1", title: "Assigned task", description: "Details" as string | null,
  status: "todo", assignee_id: assignee.id as string | null, created_by_id: owner.id,
  position: 0, created_at: timestamp, updated_at: timestamp, assignee: assignee as typeof assignee | null,
};
let savedTask: typeof initialTask;

beforeEach(() => {
  clearSession();
  queryClient.setDefaultOptions({ queries: { retry: false }, mutations: { retry: false } });
  setSession("owner-token", owner);
  savedTask = { ...initialTask };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/activity")) return new Response(JSON.stringify({ activity: [], nextCursor: null }));
    if (path.endsWith("/comments")) return new Response(JSON.stringify({ comments: [], nextCursor: null }));
    if (options?.method === "PATCH" || options?.method === "POST") {
      const body = JSON.parse(options.body as string);
      if ("title" in body) savedTask.title = body.title;
      if ("assigneeId" in body) {
        savedTask.assignee_id = body.assigneeId;
        savedTask.assignee = [owner, assignee].find(user => user.id === body.assigneeId) ?? null;
      }
      return new Response(JSON.stringify({ task: savedTask }));
    }
    if (path === "/api/projects/p1") return new Response(JSON.stringify({ project: {
      id: "p1", name: "Project", description: null, owner_id: owner.id, owner,
      created_at: timestamp, updated_at: timestamp,
      memberships: [{ id: "m1", role: "admin", user: owner }, { id: "m2", role: "member", user: assignee }],
      tasks: [savedTask],
    } }));
    throw new Error(`Unexpected URL: ${path}`);
  }));
});
afterEach(() => { clearSession(); vi.unstubAllGlobals(); });

async function openTask() {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/projects/p1"]}>
        <Routes><Route path="/projects/:id" element={<ProjectPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Assigned task/ }));
}

describe("task assignments with real backend response fields", () => {
  it("initializes the editor with the existing assignee", async () => {
    await openTask();
    expect(screen.getByLabelText("assignee")).toHaveValue(assignee.id);
  });

  it("retains the assignee through a title-only save and reload", async () => {
    await openTask();
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Updated title" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    const card = await screen.findByRole("button", { name: /Updated title/ });
    expect(savedTask.assignee_id).toBe(assignee.id);
    fireEvent.click(card);
    expect(screen.getByLabelText("assignee")).toHaveValue(assignee.id);
  });

  it.each([null, owner.id])("persists an intentional assignment change to %s", async (nextAssignee) => {
    await openTask();
    fireEvent.change(screen.getByLabelText("assignee"), { target: { value: nextAssignee ?? "" } });
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Changed assignment" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    const card = await screen.findByRole("button", { name: /Changed assignment/ });
    expect(savedTask.assignee_id).toBe(nextAssignee);
    fireEvent.click(card);
    expect(screen.getByLabelText("assignee")).toHaveValue(nextAssignee ?? "");
  });

  it("maps project and nested task IDs and timestamps", async () => {
    const { project } = await getProject("p1");
    expect(project).toMatchObject({ ownerId: owner.id, createdAt: timestamp, updatedAt: timestamp });
    expect(project.tasks[0]).toMatchObject({
      projectId: "p1", assigneeId: assignee.id, createdById: owner.id,
      createdAt: timestamp, updatedAt: timestamp, assignee,
    });
    expect(project.tasks[0]).not.toHaveProperty("assignee_id");
  });

  it.each(["create", "update"] as const)("maps the %s response and preserves an unassigned task", async (operation) => {
    const input = { title: "Unassigned", assigneeId: null };
    const { task } = operation === "create" ? await createTask("p1", input) : await updateTask("t1", input);
    expect(task).toMatchObject({
      title: "Unassigned", projectId: "p1", assigneeId: null, createdById: owner.id,
      createdAt: timestamp, updatedAt: timestamp, assignee: null,
    });
  });
});
