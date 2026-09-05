import * as React from "react";
import { ArrowRight, CheckCircle2, Globe, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/shared/ui/card";
import { authenticateRelay, OPERATOR_PUBKEY, installRelayBridge } from "@/relayBridge";

export type HubConnectScreenProps = {
  onConnected?: () => void;
  defaultHubUrl?: string;
};

const RELAY_COMMUNITY_ID = "relay-hub-community";
const ONBOARDING_COMPLETION_STORAGE_KEY_PREFIX = "buzz-onboarding-complete.v1:";

export function HubConnectScreen({
  onConnected,
  defaultHubUrl = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:3456",
}: HubConnectScreenProps) {
  const [hubUrl, setHubUrl] = React.useState(defaultHubUrl);
  const [pin, setPin] = React.useState("4242");
  const [status, setStatus] = React.useState<"idle" | "connecting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const handleConnect = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!hubUrl.trim()) {
      setErrorMessage("Please enter a valid Relay Hub URL");
      return;
    }

    setStatus("connecting");
    setErrorMessage(null);

    try {
      // Ensure bridge is installed
      installRelayBridge();

      const success = await authenticateRelay(hubUrl.trim(), pin.trim());
      if (!success) {
        setStatus("error");
        setErrorMessage("Authentication failed. Please verify the Hub URL and PIN.");
        return;
      }

      // Store session and mark onboarding complete
      const wsUrl = hubUrl.replace(/^http/, "ws") + "/ws";
      const community = {
        addedAt: new Date().toISOString(),
        id: RELAY_COMMUNITY_ID,
        name: "Relay Hub",
        relayUrl: wsUrl,
      };

      window.localStorage.setItem("buzz-communities", JSON.stringify([community]));
      window.localStorage.setItem("buzz-active-community-id", RELAY_COMMUNITY_ID);
      window.localStorage.setItem(
        `${ONBOARDING_COMPLETION_STORAGE_KEY_PREFIX}${OPERATOR_PUBKEY}`,
        "true"
      );
      window.localStorage.setItem("buzz-machine-onboarding-complete.v2", "true");
      window.localStorage.setItem(
        `buzz-machine-onboarding-complete.v2:${OPERATOR_PUBKEY}`,
        "true"
      );
      window.localStorage.setItem(
        `buzz-community-onboarding-complete.v1:${encodeURIComponent(community.relayUrl)}:${OPERATOR_PUBKEY}`,
        "true"
      );
      window.localStorage.setItem("relay-hub-connected-url", hubUrl);

      setStatus("success");

      // Transition to workspace
      setTimeout(() => {
        if (onConnected) {
          onConnected();
        } else {
          window.location.href = "/";
        }
      }, 500);
    } catch (err: any) {
      setStatus("error");
      setErrorMessage(err?.message || "Could not connect to Relay Hub");
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4 text-foreground selection:bg-primary/20">
      <div className="w-full max-w-md space-y-6">
        {/* Brand Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 text-xs font-mono tracking-widest uppercase bg-muted/60 border border-border/80 text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" />
            <span>Relay IDE Desktop</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground font-mono">
            Connect to Hub
          </h1>
          <p className="text-sm text-muted-foreground">
            Connect this desktop instance to your local or paired Relay Hub.
          </p>
        </div>

        {/* Connection Card */}
        <Card className="border border-border/80 shadow-2xl bg-card/95 backdrop-blur-xs">
          <form onSubmit={handleConnect}>
            <CardHeader className="space-y-1 pb-4">
              <CardTitle className="text-base font-semibold">Hub Gateway Authentication</CardTitle>
              <CardDescription className="text-xs">
                No cryptographic keys or Nostr relays required. Relay manages durable identity.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              {errorMessage && (
                <div
                  data-testid="hub-connect-error"
                  className="rounded-none border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive font-mono"
                >
                  {errorMessage}
                </div>
              )}

              {status === "success" && (
                <div
                  data-testid="hub-connect-success"
                  className="rounded-none border border-emerald-500/50 bg-emerald-500/10 p-3 text-xs text-emerald-400 font-mono flex items-center gap-2"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Authenticated! Entering workspace...</span>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-xs font-mono font-medium tracking-wide uppercase text-muted-foreground flex items-center gap-1.5">
                  <Globe className="h-3.5 w-3.5" />
                  Hub URL
                </label>
                <Input
                  data-testid="hub-url-input"
                  type="text"
                  value={hubUrl}
                  onChange={(e) => setHubUrl(e.target.value)}
                  placeholder="http://127.0.0.1:3456"
                  disabled={status === "connecting" || status === "success"}
                  className="font-mono text-sm h-10 border-input bg-background/50 focus-visible:ring-1 focus-visible:ring-primary"
                  required
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-mono font-medium tracking-wide uppercase text-muted-foreground flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5" />
                  Hub PIN / Gateway Token
                </label>
                <Input
                  data-testid="hub-pin-input"
                  type="password"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="4242"
                  disabled={status === "connecting" || status === "success"}
                  className="font-mono text-sm h-10 border-input bg-background/50 focus-visible:ring-1 focus-visible:ring-primary"
                  required
                />
                <p className="text-[11px] text-muted-foreground font-mono">
                  Default local PIN: <code className="text-foreground">4242</code>
                </p>
              </div>
            </CardContent>

            <CardFooter className="pt-2">
              <Button
                data-testid="hub-connect-submit"
                type="submit"
                disabled={status === "connecting" || status === "success"}
                className="w-full h-10 font-mono text-sm tracking-wide gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {status === "connecting" ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Connecting...
                  </>
                ) : status === "success" ? (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    Connected
                  </>
                ) : (
                  <>
                    Connect to Relay Hub
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
            </CardFooter>
          </form>
        </Card>

        {/* Footer info */}
        <div className="text-center text-xs text-muted-foreground font-mono">
          <p>Relay Channel-First Workspace • v1.0 Spike</p>
        </div>
      </div>
    </div>
  );
}
