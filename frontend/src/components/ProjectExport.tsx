import { useMutation } from "@tanstack/react-query";
import { exportProject } from "@/lib/airtable-api";

export function ProjectExport({ projectId, canExport }: { projectId: string; canExport: boolean }) {
  const exportTasks = useMutation({ mutationFn: () => exportProject(projectId) });
  const result = exportTasks.data;
  return (
    <section aria-label="Airtable export" className="mb-6 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium">Airtable export</h2>
          <p className="text-xs text-muted mt-1">Export this project's tasks. Exporting again updates existing records.</p>
        </div>
        <button type="button" disabled={!canExport || exportTasks.isPending}
          onClick={() => { if (canExport && !exportTasks.isPending) exportTasks.mutate(); }}
          className="rounded-md bg-accent px-4 py-2 text-sm text-white disabled:opacity-50 disabled:cursor-not-allowed">
          {exportTasks.isPending ? "Exporting…" : "Export to Airtable"}
        </button>
      </div>
      {!canExport && <p className="text-xs text-muted mt-2">Only project admins and members can export.</p>}
      {exportTasks.isPending && <p role="status" className="text-sm text-muted mt-3">Export is running. Keep this page open.</p>}
      {exportTasks.error && <p role="alert" className="text-sm text-red-400 mt-3">{exportTasks.error.message}</p>}
      {result && !exportTasks.isPending && (
        <div role="status" className="text-sm mt-3">
          <p>{result.total === 0 ? "This project has no tasks to export."
            : `Exported ${result.exported} of ${result.total} tasks. ${result.created} created, ${result.updated} updated.`}</p>
          {result.failed > 0 && (
            <div className="mt-2 text-amber-300">
              <p>{result.failed} task{result.failed === 1 ? "" : "s"} could not be exported. Successful records were kept; you can safely export again.</p>
              {result.error && <p>{result.error}</p>}
              <details className="mt-2">
                <summary className="cursor-pointer">View failed tasks</summary>
                <ul className="mt-2 space-y-1">
                  {result.failures.map(item => <li key={item.taskId}>{item.title ?? item.taskId}: {item.message}</li>)}
                </ul>
              </details>
            </div>
          )}
          {result.baseUrl && <a href={result.baseUrl} target="_blank" rel="noopener noreferrer" className="inline-block text-accent hover:underline mt-2">Open Airtable</a>}
        </div>
      )}
    </section>
  );
}
