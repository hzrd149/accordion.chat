import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { EventStoreProvider, AccountsProvider } from "applesauce-react/providers";
import { eventStore, accounts, loadAccounts } from "./nostr";
import { App } from "./app/App";
import "./app/index.css";

loadAccounts();

// NOTE: intentionally NOT wrapped in <StrictMode>. StrictMode's dev-only
// mount → unmount → remount double-invoke tears down and rebuilds the LiveKit
// call's Room + E2EE Web Worker mid-handshake (the worker is terminated on the
// throwaway mount's cleanup, the Room disconnected), which leaves media E2EE
// half-initialized on the surviving instance — every remote frame then fails to
// decrypt and is silently dropped (heard as no/garbled audio). LiveKit's
// connecting-Room + terminating-worker lifecycle can't survive a synchronous
// remount, a subtree can't opt out of an ancestor's StrictMode, and the call UI
// lives at the app root (persists across navigation) — so StrictMode is dropped
// app-wide, matching the armada reference client. Verified with
// scripts/drive-voice-audio.mjs (measures decoded remote-audio energy).
createRoot(document.getElementById("root")!).render(
  <EventStoreProvider eventStore={eventStore}>
    <AccountsProvider manager={accounts}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AccountsProvider>
  </EventStoreProvider>,
);
