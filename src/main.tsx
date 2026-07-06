import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EventStoreProvider, AccountsProvider } from "applesauce-react/providers";
import { eventStore, accounts, loadAccounts } from "./nostr";
import { App } from "./app/App";
import "./app/theme.css";

loadAccounts();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EventStoreProvider eventStore={eventStore}>
      <AccountsProvider manager={accounts}>
        <App />
      </AccountsProvider>
    </EventStoreProvider>
  </StrictMode>,
);
