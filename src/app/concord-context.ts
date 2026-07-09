import { createContext, useContext } from "react";
import type { ConcordClient } from "applesauce-concord";

// The context + hook live in their own (component-free) module so `context.tsx`
// can export only the `<ConcordProvider>` component — keeping React Fast Refresh
// happy (react-refresh/only-export-components).
export const ClientContext = createContext<ConcordClient | null>(null);

export function useConcord(): ConcordClient {
  const c = useContext(ClientContext);
  if (!c) throw new Error("ConcordClient not available");
  return c;
}
