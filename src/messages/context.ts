import { createContext, useContext } from "react";
import type { WrappedMessagesClient } from "applesauce-extra/messages";

export const MessagesContext = createContext<WrappedMessagesClient | null>(null);
export function useMessagesClient() {
  return useContext(MessagesContext);
}
