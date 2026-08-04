// Test fixture for startup restore: accept the stdio transport but never
// answer Codex's JSON-RPC initialize request. The parent must enforce its
// reattach deadline and terminate this process.
process.stdin.resume();
