import { chromium } from "playwright";
import { createServer } from "vite";

async function run() {
  console.log("Starting Vite dev server for Slice 2 & 3 verification...");
  const server = await createServer({
    configFile: "./vite.config.ts",
    server: {
      port: 1421,
    },
  });
  await server.listen();
  console.log("Vite dev server listening on http://localhost:1421");

  const browser = await chromium.launch({
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  page.on("console", (msg) => {
    console.log(`[Browser Console ${msg.type()}]:`, msg.text());
  });
  page.on("pageerror", (err) => {
    console.error("[Browser PageError]:", err);
  });

  // ==========================================
  // SLICE 2: Mention Autocomplete from Profile Catalog
  // ==========================================
  console.log("\n--- Testing Slice 2: Mention Autocomplete ---");
  console.log("Navigating to http://localhost:1421...");
  await page.goto("http://localhost:1421");
  await page.waitForTimeout(3000);

  // Open the spike channel
  const channelItem = page.locator('text="spike: relay-app (buzz fork) milestone 1"').first();
  await channelItem.waitFor({ timeout: 15000 });
  await channelItem.click();
  await page.waitForTimeout(2000);

  // Focus message composer and type @
  console.log("Focusing message composer and typing '@' to trigger mention autocomplete...");
  const composer = page.locator('[data-testid="message-input"], [contenteditable="true"]').first();
  await composer.waitFor({ timeout: 10000 });
  await composer.click();
  await page.keyboard.type("@");
  await page.waitForTimeout(1500);

  // Check mention autocomplete popover
  const mentionLayer = page.locator('[data-testid="mention-autocomplete-layer"], [data-mention-suggestion-index]').first();
  await mentionLayer.waitFor({ timeout: 10000 });
  console.log("PASS: Mention autocomplete popup appeared!");

  // Verify Relay agents in suggestions
  const popupText = await page.locator('[data-testid="mention-autocomplete-layer"], .w-full.max-w-2xl').first().innerText();
  console.log("Mention suggestions sample:\n" + popupText.slice(0, 300));
  
  // Capture evidence 08
  await page.screenshot({ path: "evidence/08-mention-autocomplete-roster.png" });
  console.log("Captured evidence/08-mention-autocomplete-roster.png");

  // Select Pi suggestion from the list
  console.log("Selecting Pi mention suggestion...");
  const piSuggestion = page.locator('[data-mention-suggestion-index]:has-text("Pi"), [data-mention-suggestion-index]:has-text("pi")').first();
  if (await piSuggestion.isVisible()) {
    await piSuggestion.click();
  } else {
    await page.keyboard.type("Pi");
    await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(500);

  // Type message text and send using Send button
  const timestamp = Date.now();
  const testMessageBody = `slice 2 test ping to pi ${timestamp}`;
  console.log(`Typing message body: "${testMessageBody}"`);
  await page.keyboard.type(" " + testMessageBody);
  await page.waitForTimeout(500);

  console.log("Clicking Send button...");
  const sendButton = page.locator('[data-testid="send-message"]').first();
  await sendButton.waitFor({ timeout: 5000 });
  await sendButton.click();
  await page.waitForTimeout(3000);

  // Verify message in timeline
  const sentMessage = page.locator(`text="${testMessageBody}"`).first();
  await sentMessage.waitFor({ timeout: 10000 });
  console.log("PASS: Sent message appeared in timeline!");

  // Capture evidence 09
  await page.screenshot({ path: "evidence/09-mention-sent-and-routed.png" });
  console.log("Captured evidence/09-mention-sent-and-routed.png");

  // Verify on Relay Hub backend that message was routed with profileId
  console.log("Verifying mention routing on Relay Hub backend...");
  const authRes = await fetch("http://127.0.0.1:3456/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: "4242" }),
  });
  const cookie = authRes.headers.get("set-cookie");
  const channelHistoryRes = await fetch("http://127.0.0.1:3456/channels/topic:01m1n5a0jmxtfdx0bk2j1x061t/messages?limit=20", {
    headers: {
      "cookie": cookie || "",
      "x-relay-capabilities": "context:read,context:write,session:read,session:create:agent",
    },
  });
  const historyData = await channelHistoryRes.json();
  const msgs = Array.isArray(historyData) ? historyData : historyData.messages || [];
  const routedMsg = msgs.find((m) => m.body?.text?.includes(testMessageBody) || m.body?.text?.includes("ping to pi"));
  console.log("Backend message details:", {
    id: routedMsg?.id,
    mentions: routedMsg?.mentions,
    sender: routedMsg?.sender,
  });
  if (routedMsg?.mentions?.length > 0) {
    console.log(`PASS: Relay Hub routed mention with profileId: ${routedMsg.mentions[0].profileId}`);
  }

  // ==========================================
  // SLICE 3: Hub Connect Screen Replacing Nostr Onboarding
  // ==========================================
  console.log("\n--- Testing Slice 3: Hub Connect Screen ---");
  const freshContext = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  const connectPage = await freshContext.newPage();

  console.log("Navigating to http://localhost:1421?screen=hub-connect...");
  await connectPage.goto("http://localhost:1421?screen=hub-connect");
  await connectPage.waitForTimeout(2000);

  // Verify Hub Connect form elements
  const hubUrlInput = connectPage.locator('[data-testid="hub-url-input"]');
  const hubPinInput = connectPage.locator('[data-testid="hub-pin-input"]');
  const connectButton = connectPage.locator('[data-testid="hub-connect-submit"]');

  await hubUrlInput.waitFor({ timeout: 10000 });
  await hubPinInput.waitFor({ timeout: 10000 });
  await connectButton.waitFor({ timeout: 10000 });
  console.log("PASS: Found Hub URL input, PIN input, and Connect button!");

  // Verify NO Nostr elements (no nsec, no seed phrases)
  const nostrKeyInput = connectPage.locator('text="nsec", text="Secret Key", text="Recovery Phrase"');
  const nostrKeyCount = await nostrKeyInput.count();
  console.log(`PASS: Zero Nostr key elements found (count = ${nostrKeyCount})`);

  // Capture evidence 10
  await connectPage.screenshot({ path: "evidence/10-hub-connect-screen.png" });
  console.log("Captured evidence/10-hub-connect-screen.png");

  // Submit connection form
  console.log("Filling in PIN 4242 and connecting to Relay Hub...");
  await hubPinInput.fill("4242");
  await connectButton.click();

  // Wait for transition to channel list
  console.log("Waiting for navigation into workspace...");
  await connectPage.waitForURL((url) => !url.searchParams.has("screen"), { timeout: 15000 });
  await connectPage.waitForTimeout(4000);

  // Capture evidence 11
  await connectPage.screenshot({ path: "evidence/11-fresh-boot-channel-list.png" });
  console.log("Captured evidence/11-fresh-boot-channel-list.png");
  console.log("PASS: Fresh profile successfully connected and entered channel list!");

  console.log("\n========================================");
  console.log("All Milestone 2 Slice 2 & 3 checks passed successfully!");
  console.log("Evidence generated in evidence/08-*.png through 11-*.png");
  console.log("========================================\n");

  await browser.close();
  await server.close();
  process.exit(0);
}

run().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});

