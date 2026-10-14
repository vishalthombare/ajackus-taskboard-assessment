import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useNavigate } from "react-router-dom";
import App from "@/App";
import { queryClient } from "@/lib/query-client";
import { apiFetch, clearSession, getStoredUser, setSession } from "@/lib/api-client";

vi.mock("@/lib/api-client", async () => ({
  ...await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client"),
  apiFetch: vi.fn(),
}));

const alice = { id: "a", email: "alice@example.com", name: "Alice" };
const bob = { id: "b", email: "bob@example.com", name: "Bob" };
const project = {
  id: "private", name: "A private project", description: "A confidential plan", owner: alice,
  ownerId: alice.id, role: "admin", taskCount: 1, createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
  memberships: [{ id: "m1", role: "admin", user: alice }],
  tasks: [{ id: "t1", title: "A secret task", status: "todo", position: 0, assignee: null }],
};

beforeEach(() => {
  clearSession();
  queryClient.setDefaultOptions({ queries: { retry: false }, mutations: { retry: false } });
  vi.clearAllMocks();
});
afterEach(() => { cleanup(); clearSession(); });

function VisitPrivateProject() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/projects/private")}>visit private URL</button>;
}

function showApp(path = "/dashboard") {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <VisitPrivateProject />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function switchToBob() {
  fireEvent.click(screen.getByRole("button", { name: "sign out" }));
  fireEvent.change(screen.getByLabelText("email"), { target: { value: bob.email } });
  fireEvent.change(screen.getByLabelText("password"), { target: { value: "password123" } });
  fireEvent.click(screen.getByRole("button", { name: "sign in" }));
  await screen.findByText("Bob");
}

describe("private data across sessions", () => {
  it.each(["logout", "switch"] as const)("removes query and mutation data on %s", async (action) => {
    setSession("a-token", alice);
    queryClient.setQueryData(["projects", alice.id], { projects: [project] });
    queryClient.setQueryData(["project", alice.id, project.id], { project });
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => ({ privateResult: "A secret task" }),
    });
    await mutation.execute(undefined);

    if (action === "logout") clearSession();
    else setSession("b-token", bob);

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(getStoredUser()?.id).toBe(action === "switch" ? bob.id : undefined);
  });

  it("aborts pending queries and prevents a late result from restoring private data", async () => {
    setSession("a-token", alice);
    let signal: AbortSignal | undefined;
    let finish!: (value: { project: typeof project }) => void;
    const pending = queryClient.fetchQuery({
      queryKey: ["project", alice.id, project.id],
      queryFn: ({ signal: requestSignal }) => {
        signal = requestSignal;
        return new Promise<{ project: typeof project }>((resolve) => { finish = resolve; });
      },
    }).catch(() => undefined);

    setSession("b-token", bob);
    expect(signal?.aborted).toBe(true);
    finish({ project });
    await pending;
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it.each(["pending", "forbidden"] as const)("never renders A's dashboard while B's request is %s", async (mode) => {
    setSession("a-token", alice);
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path === "/api/auth/login") return { token: "b-token", user: bob };
      if (getStoredUser()?.id === alice.id) return { projects: [project] };
      if (mode === "pending") return new Promise(() => {});
      throw new Error("forbidden");
    });
    showApp();
    await screen.findByText("A private project");
    await switchToBob();

    expect(screen.queryByText("A private project")).not.toBeInTheDocument();
    expect(screen.queryByText("A confidential plan")).not.toBeInTheDocument();
    if (mode === "forbidden") await screen.findByText("forbidden");
    else expect(screen.getByText("loading…")).toBeInTheDocument();
    expect(screen.queryByText("A private project")).not.toBeInTheDocument();
  });

  it("does not reveal cached tasks when B opens A's private project URL", async () => {
    setSession("a-token", alice);
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path === "/api/auth/login") return { token: "b-token", user: bob };
      if (path === "/api/projects") return { projects: [] };
      if (getStoredUser()?.id === alice.id) return { project };
      throw new Error("forbidden");
    });
    showApp("/projects/private");
    await screen.findByText("A secret task");
    await switchToBob();
    fireEvent.click(screen.getByRole("button", { name: "visit private URL" }));
    await screen.findByText("forbidden");
    expect(screen.queryByText("A secret task")).not.toBeInTheDocument();
    expect(screen.queryByText("A private project")).not.toBeInTheDocument();
    expect(screen.queryByText(alice.email)).not.toBeInTheDocument();
    await waitFor(() => expect(queryClient.getQueryData(["project", alice.id, project.id])).toBeUndefined());
  });
});
