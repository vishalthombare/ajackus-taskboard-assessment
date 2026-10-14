import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, getToken, getStoredUser } from "@/lib/api-client";
import { Header } from "@/components/Header";

type ProjectSummary = {
  id: string;
  name: string;
  description: string | null;
  role: "admin" | "member" | "viewer";
  owner: { id: string; name: string; email: string };
  taskCount: number;
  createdAt: string;
};

export default function DashboardPage() {
  const navigate = useNavigate();
  const currentUserId = getStoredUser()?.id;

  useEffect(() => {
    if (!getToken()) navigate("/login", { replace: true });
  }, [navigate]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["projects", currentUserId],
    enabled: Boolean(getToken() && currentUserId),
    queryFn: ({ signal }) => apiFetch<{ projects: ProjectSummary[] }>("/api/projects", { signal }),
  });

  return (
    <div className="min-h-screen">
      <Header />

      <main className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold">your projects</h1>
        </div>

        {isLoading && <p className="text-muted text-sm">loading…</p>}
        {error && (
          <p className="text-sm text-red-400">
            {error instanceof Error ? error.message : "failed to load projects"}
          </p>
        )}

        {data && data.projects.length === 0 && (
          <p className="text-muted text-sm">no projects yet.</p>
        )}

        {data && data.projects.length > 0 && (
          <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {data.projects.map((p) => (
              <li
                key={p.id}
                className="bg-surface border border-border rounded-lg p-5 hover:border-accent transition"
              >
                <Link to={`/projects/${p.id}`} className="block">
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="font-medium">{p.name}</h2>
                    <span className="text-xs uppercase tracking-wide text-muted">
                      {p.role}
                    </span>
                  </div>
                  {p.description && (
                    <p className="text-sm text-muted mb-3 line-clamp-2">
                      {p.description}
                    </p>
                  )}
                  <p className="text-xs text-muted">
                    {p.taskCount} {p.taskCount === 1 ? "task" : "tasks"} · owner: {p.owner.name}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
