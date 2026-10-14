import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { TaskComments } from "@/components/TaskComments";
import { apiFetch, clearSession, setSession } from "@/lib/api-client";
import { queryClient } from "@/lib/query-client";

vi.mock("@/lib/api-client", async () => ({
  ...await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client"),
  apiFetch: vi.fn(),
}));
const user = { id: "u1", name: "Alice", email: "alice@example.com" };
const first = { id: "c1", author: { id: user.id, name: user.name }, body: "First discussion", createdAt: "2026-10-14T10:00:00Z" };
const second = { ...first, id: "c2", body: "Second discussion", createdAt: "2026-10-14T11:00:00Z" };

function show(canPost = true, taskId = "t1") {
  return render(<QueryClientProvider client={queryClient}><TaskComments taskId={taskId} projectId="p1" canPost={canPost} /></QueryClientProvider>);
}

beforeEach(() => {
  clearSession();
  queryClient.setDefaultOptions({ queries: { retry: false }, mutations: { retry: false } });
  setSession("token", user);
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockResolvedValue({ comments: [first], nextCursor: null });
});
afterEach(() => { cleanup(); clearSession(); });

describe("task comments", () => {
  it("shows author, time, and chronological plain text without edit or delete controls", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ comments: [first, second], nextCursor: null });
    show();
    await screen.findByText("Second discussion");
    expect(screen.getAllByRole("listitem").map(item => item.textContent)).toEqual([
      expect.stringContaining("First discussion"), expect.stringContaining("Second discussion"),
    ]);
    expect(screen.getAllByText("Alice")).toHaveLength(2);
    expect(document.querySelector('time[datetime="2026-10-14T10:00:00Z"]')).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit|delete/i })).not.toBeInTheDocument();
  });

  it("lets viewers read without offering a post action", async () => {
    show(false);
    await screen.findByText(first.body);
    expect(screen.queryByRole("button", { name: "Post comment" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("comment")).not.toBeInTheDocument();
    expect(screen.getByText("Comments are read-only for viewers.")).toBeInTheDocument();
  });

  it("posts a comment, clears the draft, and displays the new record", async () => {
    vi.mocked(apiFetch).mockImplementation(async (_path, options) => options?.method === "POST"
      ? { comment: second } : { comments: [first], nextCursor: null });
    show();
    await screen.findByText(first.body);
    fireEvent.change(screen.getByLabelText("comment"), { target: { value: " Second discussion " } });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await screen.findByText(second.body);
    expect(screen.getByLabelText("comment")).toHaveValue("");
    expect(apiFetch).toHaveBeenCalledWith("/api/tasks/t1/comments", { method: "POST", body: JSON.stringify({ body: second.body }) });
  });

  it("retains a failed draft and permits retry", async () => {
    vi.mocked(apiFetch).mockImplementation(async (_path, options) => {
      if (options?.method === "POST") throw new Error("Comment could not be saved. Please retry.");
      return { comments: [], nextCursor: null };
    });
    show();
    fireEvent.change(screen.getByLabelText("comment"), { target: { value: "Keep my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("comment")).toHaveValue("Keep my draft");
    expect(screen.getByRole("button", { name: "Post comment" })).toBeEnabled();
  });

  it("loads additional pages without duplicating a recently posted comment", async () => {
    let posted = false;
    vi.mocked(apiFetch).mockImplementation(async (path, options) => {
      if (options?.method === "POST") { posted = true; return { comment: second }; }
      if (path.includes("cursor=")) return { comments: [second], nextCursor: null };
      return { comments: [first], nextCursor: "page-two" };
    });
    show();
    await screen.findByText(first.body);
    fireEvent.change(screen.getByLabelText("comment"), { target: { value: second.body } });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await screen.findByText(second.body);
    expect(posted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Load more comments" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more comments" })).not.toBeInTheDocument());
    expect(screen.getAllByText(second.body)).toHaveLength(1);
  });

  it("does not display another account's cached thread", async () => {
    show(false);
    await screen.findByText(first.body);
    cleanup();
    clearSession();
    setSession("bob-token", { id: "u2", name: "Bob", email: "bob@example.com" });
    vi.mocked(apiFetch).mockImplementation(async () => { throw new Error("forbidden"); });
    show(false);
    await screen.findByText("forbidden");
    expect(screen.queryByText(first.body)).not.toBeInTheDocument();
  });
});
