import { matchPath } from "react-router";

/** Defaults only apply to landing routes, never to an explicit destination. */
export function defaultRoute(
  pathname: string,
  firstCommunityId: string | undefined,
  activeCommunityId: string | undefined,
  firstChannelId: string | undefined,
): string | undefined {
  if (matchPath("/", pathname)) {
    return firstCommunityId ? `/c/${firstCommunityId}` : undefined;
  }

  const communityRoot = matchPath("/c/:cid", pathname);
  // Hooks may retain the previous community for a render after navigation.
  if (communityRoot && communityRoot.params.cid === activeCommunityId && firstChannelId) {
    return `/c/${activeCommunityId}/${firstChannelId}`;
  }
}
