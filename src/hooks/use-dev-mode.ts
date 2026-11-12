import { useEffect, useState } from "react";
import { DEV_MODE_CHANGE_EVENT, getDevMode } from "../services/dev-mode";

/** Read/subscribe to the developer-mode flag; re-renders when it changes. */
export function useDevMode(): boolean {
  const [enabled, setEnabled] = useState<boolean>(getDevMode);
  useEffect(() => {
    const onChange = () => setEnabled(getDevMode());
    window.addEventListener(DEV_MODE_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(DEV_MODE_CHANGE_EVENT, onChange);
  }, []);
  return enabled;
}
