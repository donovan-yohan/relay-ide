const HEALTH_URL = "http://127.0.0.1:8787/health";
const status = document.querySelector("#status");

async function renderLiveness() {
  try {
    const response = await fetch(HEALTH_URL);
    if (!response.ok) {
      throw new Error("liveness request failed");
    }

    const health = await response.json();
    if (health.api !== "relay-factory/v1" || health.service !== "hub" || health.status !== "ok") {
      throw new Error("unexpected liveness response");
    }

    status.textContent = `${health.service} is ${health.status} (${health.version})`;
  } catch {
    status.textContent = "Hub liveness is unavailable.";
  }
}

void renderLiveness();
