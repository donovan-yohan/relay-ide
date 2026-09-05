import { HubConnectScreen } from "@/features/onboarding/ui/HubConnectScreen";

export type WelcomeSetupProps = {
  initialPage?: any;
  initialTransitionMode?: any;
  onBack?: () => void;
};

export function WelcomeSetup(_props: WelcomeSetupProps) {
  return <HubConnectScreen onConnected={() => { window.location.href = "/"; }} />;
}
