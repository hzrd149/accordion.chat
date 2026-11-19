import { combineLatest, map, of, type Observable } from "rxjs";
import { use$ } from "applesauce-react/hooks";
import type { Rumor } from "@applesauce/concord";
import { useCommunity } from "./use-community";
import type { ActivityInput } from "../helpers/member-trace";

/** Guestbook rumors plus every store the SDK counts as observed activity. */
export function useMemberActivityInputs(cid: string) {
  const community = useCommunity(cid);
  const views = use$(() => community?.channelViews$, [community]);
  const privateIds = (views ?? []).filter((v) => v.private && v.accessible).map((v) => `${v.channel_id}\u0000${v.name}`).join("\u0001");
  return use$(() => {
    if (!community) return of(undefined);
    const sources: { label: string; rumors$: ReturnType<typeof community.rumorStore.timeline> }[] = [
      { label: "guestbook", rumors$: community.guestbookStore.timeline([{}]) },
      { label: "public channels", rumors$: community.rumorStore.timeline([{}]) },
    ];
    for (const entry of privateIds ? privateIds.split("\u0001") : []) {
      const [id, name] = entry.split("\u0000");
      try {
        sources.push({ label: `#${name}`, rumors$: community.channelStore(id).timeline([{}]) });
      } catch {
        // Key missing or storage cleanup pending; the SDK does not observe it either.
      }
    }
    return combineLatest(sources.map((s) => s.rumors$.pipe(map((rumors) => ({ label: s.label, rumors: rumors as Rumor[] }))))) as Observable<ActivityInput[]>;
  }, [community, privateIds]);
}
