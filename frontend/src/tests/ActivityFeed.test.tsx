import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ActivityFeed } from "@/components/ActivityFeed";
import ProjectPage from "@/pages/ProjectPage";
import { apiFetch, clearSession, setSession } from "@/lib/api-client";
import { queryClient } from "@/lib/query-client";
import type { ProjectActivity } from "@/lib/activity-api";

vi.mock("@/lib/api-client", async () => ({
  ...await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client"),
  apiFetch: vi.fn(),
}));
const alice = { id: "u1", name: "Alice", email: "alice@example.com" };
const viewer = { id: "u2", name: "Viewer", email: "viewer@example.com" };
const created: ProjectActivity = {
  id: "e1", actor: alice, task: { id: "t1", title: "Board task" },
  eventType: "task_created", body: null, changes: {}, createdAt: "2026-10-14T10:00:00Z",
};
const status: ProjectActivity = { ...created, id: "e2", eventType: "task_updated", changes: { status: { from: "todo", to: "done" } }, createdAt: "2026-10-14T11:00:00Z" };
const assignment: ProjectActivity = { ...status, id: "e3", changes: { assigneeId: { from: null, to: viewer.id, fromName: null, toName: viewer.name } }, createdAt: "2026-10-14T12:00:00Z" };
const comment: ProjectActivity = { ...created, id: "e4", eventType: "comment_added", body: "<img src=x onerror=alert(1)> Ready", createdAt: "2026-10-14T13:00:00Z" };

function showFeed(projectId = "p1") {
  return render(<QueryClientProvider client={queryClient}><ActivityFeed projectId={projectId} /></QueryClientProvider>);
}

beforeEach(() => {
  clearSession();
  queryClient.setDefaultOptions({ queries: { retry: false }, mutations: { retry: false } });
  setSession("alice-token", alice);
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockResolvedValue({ activity: [created], nextCursor: null });
});
afterEach(() => { cleanup(); clearSession(); });

describe("project activity feed", () => {
  it("shows actors, times, and all four actions newest first with safe comment text", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ activity: [comment, assignment, status, created], nextCursor: null });
    showFeed();
    await screen.findByText(comment.body!);
    const list = screen.getByRole("list", { name: "Activity, newest first" });
    expect(Array.from(list.children).map(item => item.textContent)).toEqual([
      expect.stringContaining("commented on"), expect.stringContaining("Assignee: Unassigned → Viewer"),
      expect.stringContaining("Status: To do → Done"), expect.stringContaining("created task"),
    ]);
    expect(screen.getAllByText(alice.name)).toHaveLength(4);
    expect(document.querySelector('time[datetime="2026-10-14T13:00:00Z"]')).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).not.toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith("/api/projects/p1/activity", { signal: expect.any(AbortSignal) });
  });

  it("shows an empty state", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ activity: [], nextCursor: null });
    showFeed();
    expect(await screen.findByText("No activity yet.")).toBeInTheDocument();
  });

  it("retains the API order for tied timestamps and deduplicates older pages", async () => {
    const tied = { ...status, createdAt: created.createdAt };
    vi.mocked(apiFetch).mockImplementation(async path => path.includes("cursor=")
      ? { activity: [tied, created], nextCursor: null }
      : { activity: [tied], nextCursor: "older+/=" });
    showFeed();
    fireEvent.click(await screen.findByRole("button", { name: "Load older activity" }));
    await screen.findByText(/created task/);
    expect(screen.getAllByText("Status: To do → Done")).toHaveLength(1);
    const list = screen.getByRole("list", { name: "Activity, newest first" });
    expect(list.children).toHaveLength(2);
    expect(list.children[0].textContent).toContain("Status: To do → Done");
    expect(apiFetch).toHaveBeenCalledWith("/api/projects/p1/activity?cursor=older%2B%2F%3D", { signal: expect.any(AbortSignal) });
  });

  it("shows errors and lets the reader refresh successfully", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error("Activity temporarily unavailable"));
    showFeed();
    expect(await screen.findByRole("alert")).toHaveTextContent("Activity temporarily unavailable");
    vi.mocked(apiFetch).mockResolvedValue({ activity: [created], nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    await screen.findByText(/created task/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("preserves loaded activity when an older page fails and permits retry", async () => {
    vi.mocked(apiFetch).mockImplementation(async path => {
      if (path.includes("cursor=")) throw new Error("Older activity failed");
      return { activity: [status], nextCursor: "older" };
    });
    showFeed();
    fireEvent.click(await screen.findByRole("button", { name: "Load older activity" }));
    await screen.findByText("Older activity failed");
    expect(screen.getByText("Status: To do → Done")).toBeInTheDocument();
    vi.mocked(apiFetch).mockImplementation(async path => path.includes("cursor=")
      ? { activity: [created], nextCursor: null } : { activity: [status], nextCursor: "older" });
    fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
    await screen.findByText(/created task/);
  });

  it("does not reuse another project's feed", async () => {
    const shown = showFeed();
    await screen.findByText(/created task/);
    vi.mocked(apiFetch).mockImplementation(async () => new Promise(() => {}));
    shown.rerender(<QueryClientProvider client={queryClient}><ActivityFeed projectId="p2" /></QueryClientProvider>);
    expect(screen.queryByText(/created task/)).not.toBeInTheDocument();
    expect(await screen.findByText("Loading activity…")).toBeInTheDocument();
  });

  it("clears private activity on account switching", async () => {
    showFeed();
    await screen.findByText(/created task/);
    cleanup();
    setSession("other-token", viewer);
    vi.mocked(apiFetch).mockRejectedValue(new Error("forbidden"));
    showFeed();
    await screen.findByText("forbidden");
    expect(screen.queryByText(/created task/)).not.toBeInTheDocument();
    expect(queryClient.getQueryData(["activity", alice.id, "p1"])).toBeUndefined();
  });

  it("does not fetch without a session", () => {
    clearSession();
    showFeed();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Recent activity" })).not.toBeInTheDocument();
  });
});

function showProject(role: "admin" | "viewer" = "admin") {
  let activities = [created];
  const task = {
    id: "t1", project_id: "p1", title: "Board task", description: null,
    status: "todo", assignee_id: null as string | null, created_by_id: alice.id, position: 0,
    created_at: created.createdAt, updated_at: created.createdAt, assignee: null,
  };
  const project = {
    id: "p1", name: "Project", description: null, owner: alice, owner_id: alice.id,
    created_at: created.createdAt, updated_at: created.createdAt, tasks: [task],
    memberships: [{ id: "m1", role, user: alice }, { id: "m2", role: "viewer", user: viewer }],
  };
  vi.mocked(apiFetch).mockImplementation(async (path, options) => {
    if (path === "/api/projects/p1/activity") return { activity: [...activities], nextCursor: null };
    if (path === "/api/projects/p1") return { project };
    if (path === "/api/projects/p1/tasks" && options?.method === "POST") {
      const body = JSON.parse(options.body as string);
      const newTask = { ...task, id: "t2", title: body.title };
      project.tasks.push(newTask);
      activities = [{ ...created, id: "new", task: { id: "t2", title: body.title } }, ...activities];
      return { task: newTask };
    }
    if (path === "/api/tasks/t1" && options?.method === "PATCH") {
      const body = JSON.parse(options.body as string);
      task.status = body.status;
      task.assignee_id = body.assigneeId;
      activities = [{ ...status, changes: { ...status.changes, ...assignment.changes } }, ...activities];
      return { task };
    }
    if (path === "/api/tasks/t1/comments") {
      if (options?.method === "POST") {
        const body = JSON.parse(options.body as string).body;
        activities = [{ ...comment, body }, ...activities];
        return { comment: { id: "c1", author: alice, body, createdAt: comment.createdAt } };
      }
      return { comments: [], nextCursor: null };
    }
    throw new Error(`Unexpected URL: ${path}`);
  });
  render(<QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={["/projects/p1"]}>
      <Routes><Route path="/projects/:id" element={<ProjectPage />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>);
}

describe("activity refresh after project actions", () => {
  it("refreshes after task creation", async () => {
    showProject();
    await screen.findByText(/created task/);
    fireEvent.change(screen.getByPlaceholderText("task title"), { target: { value: "Fresh work" } });
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    const region = screen.getByRole("region", { name: "Recent activity" });
    await within(region).findByText("“Fresh work”");
  });

  it("refreshes status and assignee changes after saving a task", async () => {
    showProject();
    fireEvent.click(await screen.findByRole("button", { name: /Board task/ }));
    fireEvent.change(screen.getByLabelText("status"), { target: { value: "done" } });
    fireEvent.change(screen.getByLabelText("assignee"), { target: { value: viewer.id } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await screen.findByText("Status: To do → Done");
    expect(screen.getByText("Assignee: Unassigned → Viewer")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "save" })).not.toBeInTheDocument());
  });

  it("refreshes after a comment is posted", async () => {
    showProject();
    fireEvent.click(await screen.findByRole("button", { name: /Board task/ }));
    fireEvent.change(screen.getByLabelText("comment"), { target: { value: "Discuss this work" } });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    const region = screen.getByRole("region", { name: "Recent activity" });
    await within(region).findByText("Discuss this work");
    expect(within(region).getByText(/commented on/)).toBeInTheDocument();
  });

  it("lets viewers read and refresh the feed", async () => {
    showProject("viewer");
    await screen.findByText(/created task/);
    expect(screen.getByRole("button", { name: "add" })).toBeDisabled();
    const before = vi.mocked(apiFetch).mock.calls.filter(([path]) => path.endsWith("/activity")).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path.endsWith("/activity")).length).toBeGreaterThan(before));
  });
});
