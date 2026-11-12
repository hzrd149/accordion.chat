import { useEffect, useState } from "react";
import {
  getOpenRankingProvider, setOpenRankingProvider, resetOpenRankingProvider, OPEN_RANKING_CHANGE_EVENT,
} from "../services/open-ranking";

export function useOpenRankingProvider(): {
  provider: string;
  setProvider: (provider: string) => string;
  resetProvider: () => void;
} {
  const [provider, setProviderState] = useState(getOpenRankingProvider);

  useEffect(() => {
    const onChange = () => setProviderState(getOpenRankingProvider());
    window.addEventListener(OPEN_RANKING_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(OPEN_RANKING_CHANGE_EVENT, onChange);
  }, []);

  return {
    provider,
    setProvider: setOpenRankingProvider,
    resetProvider: resetOpenRankingProvider,
  };
}
