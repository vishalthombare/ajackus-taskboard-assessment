import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TaskDetail } from "@/components/TaskDetail";
import { apiFetch, clearSession, setSession } from "@/lib/api-client";
import type { ApiTask, Role } from "@/types";

vi.mock("@/lib/api-client", async () => ({
  ...await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client"),
  apiFetch: vi.fn(),
}));

const user = { id: "u1", email: "meera@example.com", name: "Meera" };
const task: ApiTask = {
  id: "t1", projectId: "p1", title: "A task", description: "Details",
  status: "todo", assigneeId: "u1", createdById: "u1", position: 0,
  createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z",
};

function showTask(role?: Role) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <TaskDetail task={task} projectId="p1" onClose={onClose}
        members={role ? [{ id: "m1", role, user }] : []} />
    </QueryClientProvider>,
  );
  return onClose;
}

beforeEach(() => {
  vi.clearAllMocks();
  setSession("test-token", user);
  vi.mocked(apiFetch).mockResolvedValue({ task });
});
afterEach(() => { cleanup(); clearSession(); });

describe("task editor permissions", () => {
  it.each(["viewer", undefined] as const)("prevents updates and deletion for role %s", (role) => {
    showTask(role);
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "delete task" })).toBeDisabled();
    for (const label of ["title", "description", "status", "assignee"]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    fireEvent.click(screen.getByRole("button", { name: "delete task" }));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("uses the signed-in user's membership rather than another member's role", () => {
    setSession("other-token", { id: "outsider", email: "other@example.com", name: "Other" });
    showTask("admin");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "delete task" })).toBeDisabled();
  });

  it.each(["admin", "member"] as const)("allows %s to save", async (role) => {
    const onClose = showTask(role);
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledWith("/api/tasks/t1", {
      method: "PATCH",
      body: JSON.stringify({ title: "Updated", description: "Details", status: "todo", assigneeId: "u1" }),
    });
  });

  it.each(["admin", "member"] as const)("allows %s to delete", async (role) => {
    const onClose = showTask(role);
    fireEvent.click(screen.getByRole("button", { name: "delete task" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledWith("/api/tasks/t1", { method: "DELETE" });
  });
});
