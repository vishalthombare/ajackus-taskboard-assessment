import { useInfiniteQuery } from "@tanstack/react-query";
import { getStoredUser, getToken } from "@/lib/api-client";
import { activityQueryKey, getActivity, type ActivityChange, type ProjectActivity } from "@/lib/activity-api";
import { STATUS_LABELS, type TaskStatus } from "@/types";

function changeText(field: string, change: ActivityChange): string {
  if (field === "description") return change.to ? "Updated description." : "Cleared description.";
  if (field === "assigneeId") {
    const before = change.from ? change.fromName ?? "Former user" : "Unassigned";
    const after = change.to ? change.toName ?? "Former user" : "Unassigned";
    return `Assignee: ${before} → ${after}`;
  }
  if (field === "status") {
    const label = (value: string | number | null) => STATUS_LABELS[value as TaskStatus] ?? String(value ?? "None");
    return `Status: ${label(change.from)} → ${label(change.to)}`;
  }
  const label = field === "title" ? "Title" : field === "position" ? "Position" : field;
  return `${label}: ${change.from ?? "None"} → ${change.to ?? "None"}`;
}

export function ActivityFeed({ projectId }: { projectId: string }) {
  const userId = getStoredUser()?.id;
  const signedIn = Boolean(userId && getToken());
  const feed = useInfiniteQuery({
    queryKey: activityQueryKey(userId, projectId),
    enabled: signedIn,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => getActivity(projectId, pageParam, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const unique = new Map<string, ProjectActivity>();
  for (const event of feed.data?.pages.flatMap(page => page.activity) ?? []) unique.set(event.id, event);
  // The API orders by the full timestamp and UUID; preserve that order across pages.
  const activity = [...unique.values()];

  if (!signedIn) return null;
  return (
    <section aria-label="Recent activity" className="mt-10 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-sm font-medium">Recent activity</h2>
        <button type="button" onClick={() => void feed.refetch()} disabled={feed.isFetching}
          className="text-sm text-accent disabled:opacity-50">
          {feed.isFetching && !feed.isFetchingNextPage ? "Refreshing…" : "Refresh activity"}
        </button>
      </div>
      {feed.isPending && <p className="text-sm text-muted">Loading activity…</p>}
      {feed.error && <p role="alert" className="text-sm text-red-400 mb-3">{feed.error.message}</p>}
      {!feed.isPending && !feed.error && activity.length === 0 && <p className="text-sm text-muted">No activity yet.</p>}
      <ol aria-label="Activity, newest first" className="divide-y divide-border">
        {activity.map(event => (
          <li key={event.id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="text-sm break-words min-w-0 flex-1">
                <span className="font-medium">{event.actor.name}</span>{" "}
                {event.eventType === "task_created" ? "created task" : event.eventType === "comment_added" ? "commented on" : "updated task"}{" "}
                <span className="font-medium">“{event.task.title}”</span>
              </p>
              <time dateTime={event.createdAt} className="text-xs text-muted">{new Date(event.createdAt).toLocaleString()}</time>
            </div>
            {event.eventType === "task_updated" && (
              <ul className="text-xs text-muted mt-2 space-y-1 break-words">
                {Object.entries(event.changes).map(([field, change]) => <li key={field}>{changeText(field, change)}</li>)}
              </ul>
            )}
            {event.eventType === "comment_added" && <p className="mt-2 text-sm whitespace-pre-wrap break-words line-clamp-3">{event.body}</p>}
          </li>
        ))}
      </ol>
      {feed.hasNextPage && (
        <button type="button" onClick={() => void feed.fetchNextPage()} disabled={feed.isFetching}
          className="mt-4 text-sm text-accent disabled:opacity-50">
          {feed.isFetchingNextPage ? "Loading…" : "Load older activity"}
        </button>
      )}
    </section>
  );
}
