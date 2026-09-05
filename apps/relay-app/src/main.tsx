import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@/app/App";
import { RootErrorBoundary } from "@/app/RootErrorBoundary";
import { NostrBindConsentDialog } from "@/features/profile/ui/NostrBindConsentDialog";
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/inter/opsz-italic.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@/shared/styles/globals.css";
import { UpdaterProvider } from "@/features/settings/hooks/UpdaterProvider";
import { migrateLegacyCommunityStorageBeforeRender } from "@/features/communities/legacyCommunityStorage";
import { CommunitiesProvider } from "@/features/communities/useCommunities";
import { huddleWindowChannelId } from "@/features/huddle/lib/huddleWindow";
import { CommunityOnboardingProvider } from "@/features/onboarding/communityOnboarding";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { EmojiBurstProvider } from "@/shared/ui/EmojiBurstProvider";
import { PoofBurstProvider } from "@/shared/ui/PoofBurstProvider";
import { Toaster } from "@/shared/ui/sonner";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { recoverLocalStorageQuotaOnStartup } from "@/shared/lib/localStorageQuota";
import { startLocalStorageSweep } from "@/shared/lib/localStorageSweep";
import { initializeConversationDensityPreference } from "@/shared/lib/conversationDensityPreference";
import { initializeFontSizePreference } from "@/shared/lib/fontSizePreference";

type E2eWindow = Window & {
  __BUZZ_E2E__?: unknown;
};

const E2E_DEFAULT_PUBKEY = "deadbeef".repeat(8);
const E2E_COMMUNITY_ID = "e2e-default-community";
const ONBOARDING_COMPLETION_STORAGE_KEY_PREFIX = "buzz-onboarding-complete.v1:";
const DEV_STATE_RESET_PARAM = "resetDevState";

function resetDevWebviewStateFromUrl() {
  if (!import.meta.env.DEV) {
    return;
  }

  const url = new URL(window.location.href);
  if (url.searchParams.get(DEV_STATE_RESET_PARAM) !== "1") {
    return;
  }

  // WebKit groups every Buzz binary under one disk directory, but storage is
  // isolated by origin. Clearing here resets only this dev server's origin;
  // deleting the shared WebKit directory would also destroy installed-app state.
  window.localStorage.clear();
  window.sessionStorage.clear();
  url.searchParams.delete(DEV_STATE_RESET_PARAM);
  window.history.replaceState(window.history.state, "", url);
}

function configureDevE2eBridgeFromUrl() {
  if (!import.meta.env.DEV) {
    return;
  }

  const url = new URL(window.location.href);
  if (url.searchParams.get("e2e") !== "mock") {
    return;
  }

  const e2eWindow = window as E2eWindow;
  e2eWindow.__BUZZ_E2E__ ??= { mode: "mock" };

  const community = {
    addedAt: new Date().toISOString(),
    id: E2E_COMMUNITY_ID,
    name: "E2E Test",
    relayUrl: "ws://localhost:3000",
  };
  window.localStorage.setItem("buzz-communities", JSON.stringify([community]));
  window.localStorage.setItem("buzz-active-community-id", E2E_COMMUNITY_ID);
  window.localStorage.setItem(
    `${ONBOARDING_COMPLETION_STORAGE_KEY_PREFIX}${E2E_DEFAULT_PUBKEY}`,
    "true",
  );
}

function renderApp() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {/* block/buzz#5078 — catch any uncaught render error so a WebKit
          SecurityError from localStorage can't blank the whole window. */}
      <RootErrorBoundary>
        <CommunitiesProvider>
          <CommunityOnboardingProvider
            enabled={huddleWindowChannelId() === null}
          >
            <ThemeProvider defaultTheme="buzz">
              <TooltipProvider>
                <EmojiBurstProvider>
                  <PoofBurstProvider>
                    <UpdaterProvider>
                      <App />
                      <NostrBindConsentDialog />
                    </UpdaterProvider>
                    <Toaster />
                  </PoofBurstProvider>
                </EmojiBurstProvider>
              </TooltipProvider>
            </ThemeProvider>
          </CommunityOnboardingProvider>
        </CommunitiesProvider>
      </RootErrorBoundary>
    </React.StrictMode>,
  );
}

const RELAY_COMMUNITY_ID = "relay-hub-community";

async function configureRelayBridge() {
  (window as any).__BUZZ_E2E__ = { bootSplashHoldMs: 0 };
  const { OPERATOR_PUBKEY, installRelayBridge, authenticateRelay } = await import("@/relayBridge");
  
  await authenticateRelay();
  installRelayBridge();

  const community = {
    addedAt: new Date().toISOString(),
    id: RELAY_COMMUNITY_ID,
    name: "Relay Hub",
    relayUrl: `ws://${window.location.host}/ws`,
  };
  window.localStorage.setItem("buzz-communities", JSON.stringify([community]));
  window.localStorage.setItem("buzz-active-community-id", RELAY_COMMUNITY_ID);
  window.localStorage.setItem(
    `${ONBOARDING_COMPLETION_STORAGE_KEY_PREFIX}${OPERATOR_PUBKEY}`,
    "true",
  );
  window.localStorage.setItem("buzz-machine-onboarding-complete.v2", "true");
  window.localStorage.setItem(
    `buzz-machine-onboarding-complete.v2:${OPERATOR_PUBKEY}`,
    "true",
  );
  window.localStorage.setItem(
    `buzz-community-onboarding-complete.v1:${encodeURIComponent(community.relayUrl)}:${OPERATOR_PUBKEY}`,
    "true",
  );
}

async function installE2eBridgeIfConfigured() {
  // The mock bridge is compiled only into dev and explicit E2E builds. A
  // pre-bootstrap global alone must never activate mock IPC in production.
  if (
    !(import.meta.env.DEV || import.meta.env.MODE === "e2e") ||
    !(window as E2eWindow).__BUZZ_E2E__
  ) {
    return;
  }

  const { maybeInstallE2eTauriMocks } = await import("@/testing/e2eBridge");
  maybeInstallE2eTauriMocks();
}

import { HubConnectScreen } from "@/features/onboarding/ui/HubConnectScreen";

function renderHubConnect() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <RootErrorBoundary>
        <ThemeProvider defaultTheme="buzz">
          <TooltipProvider>
            <HubConnectScreen
              onConnected={() => {
                const url = new URL(window.location.href);
                url.searchParams.delete("screen");
                window.location.href = url.pathname + (url.search ? url.search : "");
              }}
            />
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </RootErrorBoundary>
    </React.StrictMode>
  );
}

async function bootstrap() {
  resetDevWebviewStateFromUrl();
  const url = new URL(window.location.href);
  if (url.searchParams.get("e2e") === "mock") {
    configureDevE2eBridgeFromUrl();
    await installE2eBridgeIfConfigured();
  } else {
    await configureRelayBridge();
  }
  recoverLocalStorageQuotaOnStartup();
  initializeConversationDensityPreference();
  initializeFontSizePreference();
  startLocalStorageSweep();
  await migrateLegacyCommunityStorageBeforeRender();

  if (url.searchParams.get("screen") === "hub-connect") {
    renderHubConnect();
  } else {
    renderApp();
  }
}

void bootstrap();

