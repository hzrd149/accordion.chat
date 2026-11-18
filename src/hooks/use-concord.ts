import { use$ } from "applesauce-react/hooks";
import type { ConcordClient } from "@applesauce/concord";
import { concordClient$ } from "../services/concord";

export function useConcord(): ConcordClient {
  const c = use$(concordClient$);
  if (!c) throw new Error("ConcordClient not available");
  return c;
}
