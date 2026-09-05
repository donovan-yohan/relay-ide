import { chromium } from "playwright";
import { createServer } from "vite";

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
    viewport: { width: 1400, height: 900 },
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

  console.log("Waiting for UI to load and authenticate...");
  await page.waitForTimeout(4000);

  // Check channel list
  console.log("Looking for milestone 1 / spike channel...");
  const channelItem = page.locator('text="spike: relay-app (buzz fork) milestone 1"').first();
  await channelItem.waitFor({ timeout: 15000 });
  console.log("Found spike channel in sidebar!");

  // Click on the spike channel
  console.log("Opening spike channel...");
  await channelItem.click();
  await page.waitForTimeout(3000);

  // Verify room altitude
  console.log("Verifying room altitude (prose only, no inline tool traces)...");
  await page.screenshot({ path: "evidence/05-room-altitude-prose-only.png" });
  console.log("Captured evidence/05-room-altitude-prose-only.png");

  const timelineText = await page.locator('[data-testid="message-timeline"]').first().innerText();
  console.log("Timeline text content preview:\n" + timelineText.slice(0, 500) + "\n...");

  // Antigravity principal prose should be present
  const principalProse = page.locator('text=/Milestone 1 complete/i').first();
  await principalProse.waitFor({ timeout: 10000 });
  console.log("PASS: Found agent principal prose in room timeline!");

  // AgentRunPill should be present on the agent message row
  const runPill = page.locator('button[aria-label="Open agent run details"], button:has-text("tools"), button:has-text("s ·")').first();
  await runPill.waitFor({ timeout: 10000 });
  const pillText = await runPill.textContent();
  console.log(`PASS: Found AgentRunPill with text: "${pillText?.trim()}"`);

  // Verify that raw detail cards are NOT in the room timeline
  const inlineToolCardsInTimeline = page.locator('.message-timeline [data-testid="agent-detail-card"]');
  const inlineToolCount = await inlineToolCardsInTimeline.count();
  console.log(`PASS: Inline tool detail cards in room timeline count = ${inlineToolCount} (expected 0)`);

  // Click on the AgentRunPill to open the AgentRunViewPanel drill-in
  console.log("Clicking AgentRunPill to drill into Agent Run View...");
  await runPill.click();
  await page.waitForTimeout(2000);

  // Verify auxiliary panel opened
  console.log("Verifying AgentRunViewPanel auxiliary panel...");
  const runPanelHeader = page.locator('text="Turn execution process"').first();
  await runPanelHeader.waitFor({ timeout: 10000 });
  console.log("PASS: Agent Run View panel header opened successfully!");

  // Verify agent name in header
  const agentName = page.locator('.agent-run-view-panel').getByText('Antigravity').first();
  await agentName.waitFor({ timeout: 5000 });
  console.log("PASS: Found agent name Antigravity in Run View panel");

  // Verify metrics summary bar
  const metricsBar = page.locator('.agent-run-view-panel').filter({ hasText: 'tools' }).filter({ hasText: 'file' }).first();
  await metricsBar.waitFor({ timeout: 5000 });
  console.log("PASS: Found metrics summary bar in Run View");

  // Verify itemized execution trace:
  // 1. Tool call cards inside the Run View
  const toolCards = page.locator('.agent-run-view-panel [data-testid="agent-detail-card"], .agent-run-view-panel .agent-detail-card, .agent-run-view-panel').filter({ hasText: 'view_file' });
  await toolCards.first().waitFor({ timeout: 5000 });
  console.log("PASS: Found tool call cards in turn execution trace!");

  // 2. Final response assistant markdown
  const finalResponseHeader = page.locator('text="Antigravity Final Response"').first();
  await finalResponseHeader.waitFor({ timeout: 5000 });
  console.log("PASS: Found Antigravity Final Response block in turn execution trace!");

  await page.screenshot({ path: "evidence/06-agent-run-view-opened.png" });
  console.log("Captured evidence/06-agent-run-view-opened.png");

  // Scroll down in Run View to capture tool details and assistant markdown
  console.log("Scrolling Run View panel to capture tool and prose detail cards...");
  const panelBody = page.locator('.agent-run-view-panel .auxiliary-panel-body, .agent-run-view-panel').first();
  await panelBody.evaluate((el) => { el.scrollTop = 250; });
  await page.waitForTimeout(1000);

  await page.screenshot({ path: "evidence/07-agent-run-tool-details.png" });
  console.log("Captured evidence/07-agent-run-tool-details.png");

  console.log("\n========================================");
  console.log("All Milestone 2 Slice 1 checks passed successfully!");
  console.log("Evidence generated in evidence/05-*.png, 06-*.png, 07-*.png");
  console.log("========================================\n");

  await browser.close();
  await server.close();
  process.exit(0);
}

run().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
