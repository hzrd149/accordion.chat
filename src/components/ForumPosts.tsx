import { useMemo, useState } from "react";
import { MessageSquare, Search } from "lucide-react";
import { displaySubject, getSubject } from "@applesauce/concord/helpers";
import type { ChatMessage } from "../chat/fold";
import { formatTime } from "../helpers/util";
import { UserName } from "./User";

export function ForumPosts({
  messages,
  onOpenThread,
}: {
  messages: ChatMessage[];
  onOpenThread: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("newest");
  const posts = useMemo(() => messages.flatMap((message) => {
    const subject = getSubject(message.raw);
    if (message.deleted || subject === undefined) return [];
    return [{ message, title: displaySubject(subject).trim() || "Untitled post" }];
  }).reverse(), [messages]);

  const search = query.trim().toLocaleLowerCase();
  const visible = posts.filter(({ message, title }) =>
    (filter !== "unanswered" || message.threadReplyCount === 0) &&
    (!search || title.toLocaleLowerCase().includes(search) ||
      (message.edited ?? message.content).toLocaleLowerCase().includes(search)),
  );
  if (sort === "oldest") visible.reverse();
  if (sort === "replies") visible.sort((a, b) => b.message.threadReplyCount - a.message.threadReplyCount);

  return (
    <section aria-label="Forum posts" className="flex min-h-0 flex-1 flex-col px-4 max-sm:px-2">
      <div className="flex flex-wrap items-center gap-2 py-3">
        <label className="input input-sm min-w-40 flex-1">
          <Search size={16} aria-hidden="true" />
          <input type="search" aria-label="Search posts" placeholder="Search posts" value={query}
            onChange={(event) => setQuery(event.target.value)} />
        </label>
        <select className="select select-sm w-auto" aria-label="Filter posts" value={filter}
          onChange={(event) => setFilter(event.target.value)}>
          <option value="all">All posts</option>
          <option value="unanswered">Unanswered</option>
        </select>
        <select className="select select-sm w-auto" aria-label="Sort posts" value={sort}
          onChange={(event) => setSort(event.target.value)}>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="replies">Most replies</option>
        </select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {visible.length === 0 ? (
          <p role="status" className="py-8 text-center text-sm text-base-content/60">
            {posts.length ? "No posts match your filters." : "No posts yet."}
          </p>
        ) : (
          <ul className="divide-y divide-base-300 rounded-box border border-base-300">
            {visible.map(({ message, title }) => (
              <li key={message.id}>
                <button type="button"
                  className="flex w-full items-start gap-3 rounded-box p-3 text-left hover:bg-base-200 focus-visible:outline focus-visible:outline-primary"
                  onClick={() => onOpenThread(message.id)}>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-semibold">{title}</span>
                    <span className="line-clamp-2 break-words text-sm text-base-content/80">{message.edited ?? message.content}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-base-content/60">
                      <UserName pubkey={message.author} />
                      <time dateTime={new Date(message.ms).toISOString()}>{formatTime(message.ms)}</time>
                    </span>
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-base-content/70">
                    <MessageSquare size={14} aria-hidden="true" />
                    {message.threadReplyCount} {message.threadReplyCount === 1 ? "reply" : "replies"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
