import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectExport } from "@/components/ProjectExport";
import { apiFetch } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));
const success = { total: 7, exported: 7, created: 7, updated: 0, failed: 0, failures: [], baseUrl: "https://airtable.com/appTest" };
function show(canExport = true) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ProjectExport projectId="p1" canExport={canExport} /></QueryClientProvider>);
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(apiFetch).mockResolvedValue(success); });
afterEach(cleanup);

describe("project Airtable export", () => {
  it("disables export for viewers", () => {
    show(false);
    const button = screen.getByRole("button", { name: "Export to Airtable" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("exports and provides a link to the real base", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Export to Airtable" }));
    await screen.findByText("Exported 7 of 7 tasks. 7 created, 0 updated.");
    expect(apiFetch).toHaveBeenCalledWith("/api/projects/p1/export", { method: "POST" });
    expect(screen.getByRole("link", { name: "Open Airtable" })).toHaveAttribute("href", success.baseUrl);
  });

  it("prevents duplicate clicks while exporting", async () => {
    vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Export to Airtable" }));
    const pending = await screen.findByRole("button", { name: "Exporting…" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("shows partial success and the failed task without hiding successful records", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ...success, exported: 6, created: 6, failed: 1,
      failures: [{ taskId: "t1", title: "Bad task", code: "INVALID_VALUE", message: "Check column values", retryable: false }] });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Export to Airtable" }));
    await screen.findByText("Exported 6 of 7 tasks. 6 created, 0 updated.");
    expect(screen.getByText(/1 task could not be exported/)).toBeInTheDocument();
    expect(screen.getByText("Bad task: Check column values")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export to Airtable" })).toBeEnabled();
  });

  it("shows an actionable API error and permits retry", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error("Airtable denied access. Check token scopes."));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Export to Airtable" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Airtable denied access.");
    expect(screen.getByRole("button", { name: "Export to Airtable" })).toBeEnabled();
  });

  it("handles an empty project", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ total: 0, exported: 0, created: 0, updated: 0, failed: 0, failures: [] });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Export to Airtable" }));
    await screen.findByText("This project has no tasks to export.");
  });
});
