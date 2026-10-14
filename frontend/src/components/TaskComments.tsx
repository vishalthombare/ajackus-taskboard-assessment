import { useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { activityQueryKey } from "@/lib/activity-api";
import { getStoredUser } from "@/lib/api-client";
import { getComments, postComment } from "@/lib/comments-api";
import type { TaskComment } from "@/types";

export function TaskComments({ taskId, projectId, canPost }: { taskId: string; projectId: string; canPost: boolean }) {
  const userId = getStoredUser()?.id;
  const queryClient = useQueryClient();
  const queryKey = ["comments", userId, taskId];
  const [body, setBody] = useState("");
  const [recentComments, setRecentComments] = useState<TaskComment[]>([]);
  const thread = useInfiniteQuery({
    queryKey, enabled: Boolean(userId), initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => getComments(taskId, pageParam, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const post = useMutation({
    mutationFn: (text: string) => postComment(taskId, text),
    onSuccess: ({ comment }) => {
      setBody("");
      // Keep the new comment visible even when older pages have not all been loaded.
      setRecentComments(previous => [...previous, comment]);
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: activityQueryKey(userId, projectId) });
    },
  });
  const unique = new Map<string, TaskComment>();
  for (const item of [...(thread.data?.pages.flatMap(page => page.comments) ?? []), ...recentComments]) {
    unique.set(item.id, item);
  }
  const comments = [...unique.values()].sort((a, b) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id),
  );

  return (
    <section aria-label="Task comments" className="border-t border-border mt-6 pt-5">
      <h3 className="text-sm font-semibold mb-3">comments</h3>
      {thread.isPending && <p className="text-sm text-muted">Loading comments…</p>}
      {thread.error && <p role="alert" className="text-sm text-red-400">{thread.error.message}</p>}
      {!thread.isPending && !thread.error && comments.length === 0 && (
        <p className="text-sm text-muted">No comments yet.</p>
      )}
      <ol className="space-y-4" aria-label="Comments in chronological order">
        {comments.map(comment => (
          <li key={comment.id} className="rounded-md bg-bg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs mb-2">
              <span className="font-medium">{comment.author.name}</span>
              <time dateTime={comment.createdAt} className="text-muted">
                {new Date(comment.createdAt).toLocaleString()}
              </time>
            </div>
            <p className="text-sm whitespace-pre-wrap break-words">{comment.body}</p>
          </li>
        ))}
      </ol>
      {thread.hasNextPage && (
        <button type="button" onClick={() => void thread.fetchNextPage()} disabled={thread.isFetchingNextPage}
          className="text-sm text-accent mt-3 disabled:opacity-50">
          {thread.isFetchingNextPage ? "Loading…" : "Load more comments"}
        </button>
      )}
      {canPost ? (
        <form className="mt-4" onSubmit={event => {
          event.preventDefault();
          if (!canPost || post.isPending || !body.trim()) return;
          post.reset();
          post.mutate(body.trim());
        }}>
          <label className="block text-xs text-muted" htmlFor={`comment-${taskId}`}>comment</label>
          <textarea id={`comment-${taskId}`} value={body} onChange={event => setBody(event.target.value)}
            maxLength={5000} rows={3} disabled={post.isPending} placeholder="Add to the discussion…"
            className="mt-1 w-full rounded-md bg-bg border border-border px-3 py-2 text-sm focus:border-accent focus:outline-none" />
          {post.error && <p role="alert" className="text-sm text-red-400 mt-2">{post.error.message}</p>}
          <button type="submit" disabled={post.isPending || !body.trim()}
            className="mt-2 rounded-md bg-accent text-white text-sm px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed">
            {post.isPending ? "Posting…" : "Post comment"}
          </button>
        </form>
      ) : <p className="text-xs text-muted mt-4">Comments are read-only for viewers.</p>}
    </section>
  );
}
