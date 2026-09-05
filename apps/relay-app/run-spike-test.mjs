import { chromium } from "playwright";
import { createServer } from "vite";
import http from "node:http";

async function run() {
  console.log("Starting Vite dev server...");
  const server = await createServer({
    configFile: "./vite.config.ts",
    server: {
      port: 1420,
    },
  });
  await server.listen();
  console.log("Vite dev server listening on http://localhost:1420");

  const browser = await chromium.launch({
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  page.on("console", (msg) => {
    console.log(`[Browser Console ${msg.type()}]:`, msg.text());
  });
  page.on("pageerror", (err) => {
    console.error("[Browser PageError]:", err);
  });

  console.log("Navigating to http://localhost:1420...");
  await page.goto("http://localhost:1420");

  // Wait for UI to settle
  console.log("Waiting for UI to load...");
  await page.waitForTimeout(4000);

  await page.screenshot({ path: "evidence/00-boot.png" });
  console.log("Captured 00-boot.png");

  // Check channel list
  const channelItem = page.locator('text="relay-app spike sandbox"').first();
  await channelItem.waitFor({ timeout: 10000 });
  console.log("Found sandbox channel in list!");

  await page.screenshot({ path: "evidence/01-channel-list.png" });
  console.log("Captured 01-channel-list.png");

  // Click on the sandbox channel
  console.log("Clicking on sandbox channel...");
  await channelItem.click();
  await page.waitForTimeout(2000);

  await page.screenshot({ path: "evidence/02-channel-history.png" });
  console.log("Captured 02-channel-history.png");

  // Find composer input
  console.log("Locating composer input...");
  const composer = page.locator('[contenteditable="true"], textarea, input[placeholder*="Message"]').first();
  await composer.waitFor({ timeout: 5000 });
  await composer.click();
  await composer.fill("Hello from Buzz frontend to Relay Hub!");
  await page.keyboard.press("Enter");

  await page.waitForTimeout(2000);
  await page.screenshot({ path: "evidence/03-sent-message.png" });
  console.log("Captured 03-sent-message.png");

  // Now post a live incoming message via Relay Hub REST API
  console.log("Posting live message from CLI/REST to Relay Hub...");
  const authRes = await fetch("http://127.0.0.1:3456/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: "4242" }),
  });
  const cookieHeader = authRes.headers.get("set-cookie") || "";
  const cookieVal = cookieHeader.split(";")[0];

  const res = await fetch("http://127.0.0.1:3456/channels/topic:01m1n5bxzvt6e9634kbteqbcpe/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-relay-capabilities": "context:read,context:write,session:read,session:create:agent",
      Cookie: cookieVal,
    },
    body: JSON.stringify({
      text: "Live CLI response from Relay Hub agent runtime!",
    }),
  });
  console.log("Posted live message, status:", res.status);

  // Wait for WebSocket event to arrive and render in UI
  console.log("Waiting for live incoming message in UI...");
  const incomingMsg = page.locator('text="Live CLI response from Relay Hub agent runtime!"').first();
  await incomingMsg.waitFor({ timeout: 10000 });
  console.log("Live message appeared in UI!");

  await page.screenshot({ path: "evidence/04-live-incoming.png" });
  console.log("Captured 04-live-incoming.png");

  console.log("All verifications succeeded!");
  await browser.close();
  await server.close();
  process.exit(0);
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
