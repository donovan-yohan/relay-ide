# Review Agent Setup

> Edit this file to configure your code review agent for `/review` and `/ship` workflows.

## Default (zero-config)

With `"provider": "default"` in `docs/risk-contract.json`, the `/review` and `/ship` workflows use `pr:review` (code-quality:code-reviewer subagent). No external service needed.

## Configuring an External Reviewer

Edit the `reviewAgent` section in `docs/risk-contract.json`:

### Greptile

```json
"reviewAgent": {
  "provider": "greptile",
  "config": {
    "checkName": "Greptile Code Review",
    "rerunComment": "@greptile please re-review",
    "timeoutMinutes": 20
  }
}
```

### CodeRabbit

```json
"reviewAgent": {
  "provider": "coderabbit",
  "config": {
    "checkName": "CodeRabbit Review",
    "rerunComment": "@coderabbitai full review",
    "timeoutMinutes": 15
  }
}
```

### Custom Provider

```json
"reviewAgent": {
  "provider": "custom",
  "config": {
    "checkName": "Your Check Run Name",
    "rerunComment": "Text that triggers re-review",
    "timeoutMinutes": 20
  }
}
```

**Config fields:**

- `checkName` — The GitHub check run name the gate waits for
- `rerunComment` — Comment text posted to trigger re-review after remediation
- `timeoutMinutes` — Max time to wait for review completion (default: 20)

## How the Review Agent Works

1. After the risk gate passes, the workflow checks `reviewAgent.provider`
2. If `"default"`: spawns `pr:review` subagent directly
3. If anything else: waits for the GitHub check run matching `checkName` on the current head SHA
4. Review findings are parsed from check run output or PR review comments
5. If findings exist, the remediation-coordinator agent fixes and pushes
6. A SHA-deduped rerun comment using `rerunComment` text triggers re-review
