# Add Node / Pair Device UX Spec

Customer-facing UX spec for adding a new execution host (node) to a Relay hub: the Add Node wizard, the device-code pairing flow, pending-request approval, trust profiles, node lifecycle states, node-side CLI copy, Command Center parity, mobile/narrow behavior, and the QA evidence expected before this ships.

This is the **source of truth for copy, screens, states, and trust-profile language** for the clean node pairing UX (epic #979). It is a product/design spec only. It does not implement backend, frontend, or CLI behavior; implementation slices cite it and build against it.

> Authoritative security/runbook material lives in [`RELAY_NODE_BOOTSTRAP.md`](RELAY_NODE_BOOTSTRAP.md), [`SECURITY_POLICY.md`](SECURITY_POLICY.md), and [`OPERATOR_HANDSHAKE_GRANTS.md`](OPERATOR_HANDSHAKE_GRANTS.md). Where this spec describes copy or screens, it must not contradict those docs. In particular: **the device code is not authorization.** It only creates or locates a pending pairing request; operator approval issues a key-bound node credential.

## Scope and non-goals

In scope:

- The Add Node wizard flow and its steps.
- The device-code pairing front door and what each side sees.
- The pending-request approval card and its redaction-safe fields.
- Product-language trust profiles and how they map to capability concepts.
- The full node lifecycle state set: pending, approved, denied, expired, offline/stale, revoked, rotation, degraded, and re-pair-required.
- Node-side CLI copy for waiting, approval, denial, expiry, credential stored, link online, revoke/re-pair, and service/install guidance.
- Command Center node action family and parity expectations.
- Mobile/narrow-screen behavior for Settings → Nodes and the device-code approval route.
- The screenshots / mock evidence QA must capture.

Out of scope (for this spec and the first shippable slice):

- Implementing the UI/API/CLI behavior (those are #981–#987).
- Full fleet-admin policy templates, bulk rotation, or scheduled expiry campaigns.
- QR-code / mobile-native pairing polish and auto-discovery onboarding.
- Multi-tenant org policy administration beyond the first workspace/org scope.
- Reclaiming a revoked/lost node identity without an explicit operator ceremony.
- Claiming #683/#694 handoff is complete; this spec only supplies the pairing UX those lanes depend on.

## How implementation tickets cite this spec

This spec is the planning baseline for the #979 child ladder. Each downstream slice owns the sections below:

| Ticket | Slice                                                    | Cites                                                                                                                                                         |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #981   | Key-bound node identity + credential handshake           | [Security model and auth lanes](#security-model-and-auth-lanes), [Node lifecycle states](#node-lifecycle-states)                                              |
| #982   | Hub API pending pairing request lifecycle                | [Pending-request approval card](#pending-request-approval-card), [Node lifecycle states](#node-lifecycle-states), [Redaction rules](#redaction-rules)         |
| #983   | Node-side `relay-ide node pair <hub>` device-code client | [Device code is a locator, not a credential](#the-device-code-is-a-locator-not-a-credential), [Node-side CLI copy](#node-side-cli-copy)                       |
| #984   | Settings → Nodes management surface                      | [Add Node wizard flow](#add-node-wizard-flow), [Node cards by state](#node-cards-by-state), [Mobile / narrow-screen behavior](#mobile-narrow-screen-behavior) |
| #985   | Command Center node command projection                   | [Command Center parity](#command-center-parity)                                                                                                               |
| #986   | Command-surface drift guard                              | [Command Center parity](#command-center-parity), [Redaction rules](#redaction-rules)                                                                          |
| #987   | Dogfood lane pairing `work-mac`                          | [QA screenshot / mock evidence](#qa-screenshot-mock-evidence)                                                                                                 |

## Mental model

The customer sees three verbs: **pair device → approve device → manage device.**

- `relay-ide hub` runs the command center / web app / node registry / approval authority.
- `relay-ide node` is a lightweight local execution agent — never a full hub UI.
- `relay-ide node pair <hub>` starts a device-code pairing request from the new host.
- **Settings → Nodes** is the durable management home for paired, pending, and revoked nodes.
- **Command Center** exposes node/pairing actions from the shared command/action manifest and routes into Settings → Nodes; it is never a second pairing implementation.

The implementation still enforces the real boundary underneath that simple surface: node-generated identity, human-approved credential issuance, a key-bound node credential, challenge proof on node-link, revocation/rotation, capability scopes, and audit.

## Security model and auth lanes

This spec follows the required handshake direction from #979 and `SECURITY_POLICY.md`. Copy must never blur these steps:

1. The node creates a local private key on its first pairing attempt.
2. The node submits a pending pairing request: public key, manifest, **device code**, requested profile/capabilities, requested roots, and safe source diagnostics.
3. The hub shows the pending request to an authenticated operator.
4. The operator approves or denies the exact trust profile and capability scope (and may edit it). Higher-risk profiles require the stronger approval ceremony (the #807 exact-operation confirmation contract; passkey/WebAuthn/TOTP is future work behind that same contract).
5. The hub issues a node credential **bound to the node public-key fingerprint**, node id, trust tier, capability policy, expiry/rotation policy, and workspace/org scope.
6. `/hub/node-link` proves private-key possession with a challenge signature plus an active credential.
7. Revoke closes active links and rejects future heartbeat/reconnect. Re-pair defaults to a **new** node identity unless an explicit operator-approved reclaim path exists.

### The device code is a locator, not a credential

The device code (e.g. `7KQ-M2P`) is a short, human-transcribable handle that lets an operator **find the right pending request** on a signed-in device. It carries no authority on its own. It is not a member of any auth lane below, and it never becomes one.

Auth lanes stay separate and fail closed (see `SECURITY_POLICY.md` → Auth lanes):

| Material                                         | What it authorizes                                                                       | Never                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Browser PIN / session cookie                     | Web UI + operator routes (incl. approving a pending request, requesting rotation/revoke) | A node credential; reusable automation auth                            |
| Scoped actor credential (`relay-sac-v1…`)        | Delegated CLI/agent/automation commands in their allowlist                               | A browser login or node credential                                     |
| Node credential (key-bound)                      | Node heartbeat + `/hub/node-link` for that node only                                     | A browser login; transferable between machines                         |
| Pair token (`pair_…`) / operator-grant mint lane | One-time node bootstrap exchange (automation lane via `relay:node-pair-token:v1`)        | Browser/CLI/steady-state node auth                                     |
| Operator handshake grant (`relay-ohg-v1…`)       | One-time ceremony delegation for a named actor                                           | A reusable credential of any other lane                                |
| **Device code**                                  | **Locating a pending pairing request in the UI**                                         | **Authorization, a credential, or a substitute for operator approval** |

Hard rules the copy must respect:

- Device code is not authorization; it only creates or locates a pending request.
- Browser session is not a node credential; a node credential is not a browser login.
- Tailscale/SSH/source diagnostics are evidence, not sole auth (see `RELAY_NODE_BOOTSTRAP.md` → source diagnostics).
- Hostname/path are display metadata, not identity.
- Capability upgrades require reapproval; no silent escalation after pairing.
- No raw pair tokens, credentials, browser cookies, or grant handles in logs, diagnostics, screenshots, command descriptions, or issue comments.
- No long-lived reusable install token with broad powers.
- No auto-repair of a revoked node because a local credential file still exists.

### Relationship to the existing pair-token lane

The device-code flow is the new **human** front door. The existing operator-grant pair-token mint (`POST /hub/pair-tokens` via `relay:node-pair-token:v1`, documented in `OPERATOR_HANDSHAKE_GRANTS.md`) remains the **automation** bootstrap lane. Both ultimately produce a key-bound node credential through human-authorized issuance; neither lets the device code or a pair token act as a steady-state credential. This spec does not remove the automation lane; it adds the customer-facing device-code path beside it.

## Trust profiles

Trust profiles are product-language presets the operator chooses in the wizard and on the approval card. They map to internal capability policy and trust tiers, but **the customer-facing copy uses product language only** — it must not surface raw capability-bit strings (`rpc:fs:write`, `pty:exec:arbitrary`, …) or ACL internals. The capability mapping table below is for implementers; the operator sees the plain-language "what this allows" / "what this never allows" lines.

| Profile (customer label) | Plain-language meaning                                                                                            | Trust tier              | Default capability concept                                              | Approval strength                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| `dev workstation`        | Personal laptop/workstation. Can launch terminals/agents and read/write approved repo roots as the local OS user. | `dev`                   | session + read/write within approved roots + git + launch agents        | standard operator approval              |
| `sandbox runner`         | Disposable / CI-like workspace. Bounded tasks, narrower filesystem access.                                        | `sandbox`               | session + narrow read; write/exec only if explicitly granted            | standard operator approval              |
| `automation runner`      | Runs approved automation and publishes artifacts. No broad interactive shell by default.                          | `sandbox`/`dev` overlay | scoped automation + artifact publish; interactive shell off by default  | standard operator approval              |
| `infra / prod host`      | High-risk host. Defaults to read-only or explicitly scoped actions.                                               | `prod`                  | read-safe by default; high-risk bits require per-operation confirmation | **stronger approval ceremony required** |

Each profile in the UI must show two lines in product language:

- **can:** what this node will be allowed to do (e.g. "launch terminal sessions, read/write approved repo roots, run git, launch configured agent CLIs").
- **never:** what it will not do without a separate, re-approved upgrade (e.g. "no access outside approved roots, no silent capability changes").

For `infra / prod host`, the UI must add: "approved actions on a prod host can still require a per-operation confirmation before they run." This reflects the prod-tier exact-operation challenge in `SECURITY_POLICY.md`; the copy stays product-language and does not enumerate raw bits.

### Allowed roots

For profiles that read/write the filesystem (`dev workstation`, and `sandbox`/`automation` where granted), the wizard and approval card collect an **allowed repo roots** list in product language ("which folders this node may work in"). Roots are display metadata for the operator's decision, never identity, and the approved set is part of the issued capability policy. Editing roots after pairing is a capability change and therefore requires re-approval, not a silent edit.

## Add Node wizard flow

Settings → Nodes is the home. The empty state explains the model in one line ("nodes are machines paired to this hub that can run terminals, agents, and repo work") and offers a single primary action: **add node**.

The Add Node wizard (all step labels lowercase per `DESIGN.md`):

1. **choose node type.** dev machine · sandbox runner · automation runner · infra/prod host. Selecting a type pre-selects the matching trust profile (still editable in step 2). Each type shows its one-line plain-language summary.
2. **choose trust profile & allowed roots.** Confirm/adjust the trust profile and, where applicable, the allowed repo roots. Show the profile's `can:` / `never:` lines. For `infra / prod host`, show the stronger-approval notice up front so the operator is not surprised at approval time.
3. **copy pair command + show device-code state.** Show the exact node-side command to run (`relay-ide node pair <this-hub-url>`) with a one-tap **copy pair command** affordance, plus install guidance for a brand-new host (see [Node-side CLI copy](#node-side-cli-copy)). When the node submits its request, this step transitions to show the live device code and a "waiting for this device to check in" state. The hub never shows raw pair tokens here.
4. **incoming pairing request.** When a request arrives matching the device code, show the [pending-request approval card](#pending-request-approval-card). The operator can confirm this is the device they expected by matching the device code shown in the wizard against the code printed on the node.
5. **approve / deny / edit access.** The operator approves the requested profile, denies, or edits the trust profile / allowed roots before issuing. Higher-risk profiles trigger the stronger approval ceremony here. Editing access before approval is expected and is not a re-approval (no credential exists yet).
6. **post-approval next action.** On success, confirm "`<name>` is paired and its link is online" and offer the next action: **open a terminal/session on this node**, or **manage in Settings → Nodes**. If the node has not yet held its `/hub/node-link` (pair-only), say so and link to the install/service guidance instead of implying the node is reachable for routed sessions.

The wizard must be resumable: if the operator closes it while a request is pending, the pending request stays visible in Settings → Nodes and can be approved/denied from there. The wizard is one entry point into the same pending-request flow, not a separate state machine.

## Pending-request approval card

The approval card is the operator's trust decision surface. It must show enough **redaction-safe** evidence to make an informed approve/deny/edit decision, and nothing secret. Field set:

| Field                      | Example                                                                                                                       | Notes                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| display name               | `work-mac`                                                                                                                    | Operator-facing name; editable on approval. Display metadata, not identity.                                                         |
| device / hostname          | `work-mac · host: …book-pro.local`                                                                                            | Display metadata only; never treated as identity or authorization. Truncate/redact before UI, CLI, or screenshot output.            |
| platform                   | `macOS arm64`                                                                                                                 | From the node manifest.                                                                                                             |
| Relay version              | `Relay 0.1.0-nightly.x`                                                                                                       | From the node manifest; drives version-skew display later.                                                                          |
| source / provenance signal | `same tailnet · src_a1b2…c3d4 · displayHint: magicdns:ts.net:…tail`                                                           | Redacted source diagnostic (`displayHint`/state/fingerprint), evidence only. Never raw tailnet IP, full MagicDNS, or full hostname. |
| requested profile          | `dev workstation`                                                                                                             | The product-language trust profile the node asked for.                                                                              |
| requested capabilities     | "launch terminal sessions · attach/detach sessions · read/write approved repo roots · run git · launch configured agent CLIs" | Product language, not raw capability bits.                                                                                          |
| requested roots            | "~/code, ~/work"                                                                                                              | Only when the profile uses the filesystem. Display metadata for the decision.                                                       |
| expiry                     | `expires in 9:42`                                                                                                             | The pending request's countdown; expired requests cannot be approved.                                                               |
| audit-safe fingerprint     | `key fp: a1b2…c3d4` (truncated)                                                                                               | A stable, redacted public-key fingerprint handle the operator can compare. Never the raw key, token, or credential.                 |

Hostname and source fields are display metadata for recognition only. Every emitted surface must redact/truncate them before UI, CLI, screenshot, diagnostic, or issue-comment output: prefer the editable display name, a stable `sourceFingerprint`, a lossy suffix-only `displayHint`, or a truncated public-key fingerprint over raw hostnames, MagicDNS names, or IPs.

Required copy on the card (product-language, blunt, safe):

> `work-mac` wants to pair
> macOS arm64 · Relay nightly · source signal: same tailnet / unverified / proxy-provenance
> requested profile: dev workstation
> requested access: launch terminal sessions, attach/detach sessions, read/write approved repo roots, run git operations, launch configured agent CLIs.
> **Warning:** approved nodes can execute code as the local OS user inside their allowed roots. Approve only if you recognize this device.

Controls: **approve** · **deny** · **edit access** (change profile/roots before issuing). For `infra / prod host`, **approve** routes through the stronger approval ceremony.

> Icon note: per `DESIGN.md` ("no emoji icons"), the requested-access list uses text markers (`·`, `+`, or a monospace `[x]`), **not** emoji checkmarks. The `✓` glyphs in the #979 issue body are shorthand, not the shipped UI.

## Node lifecycle states

Two related lifecycles. Copy and reason codes must match `RELAY_NODE_BOOTSTRAP.md` and `SECURITY_POLICY.md`.

### A. Pairing-request lifecycle (before a credential exists)

| State      | Meaning                                                         | Operator-facing copy                                                            | Next action                 |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------- |
| `pending`  | Node submitted a request; waiting for operator.                 | "`<name>` wants to pair — expires in m:ss"                                      | approve / deny / edit       |
| `approved` | Operator approved; credential issued and bound to the node key. | "approved as `<name>` — issuing credential" → "`<name>` paired"                 | open terminal / manage      |
| `denied`   | Operator denied. No credential issued.                          | "pairing denied. the device was told no credential was issued."                 | (node may re-request later) |
| `expired`  | Request countdown elapsed before approval.                      | "this pairing request expired. run the pair command again to get a fresh code." | re-run pair on node         |

### B. Paired-node lifecycle (after a credential exists)

| State               | Meaning                                                                      | Reason / signal                                                                          | Operator-facing copy                                                                         |
| ------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `online`            | Live `/hub/node-link`, fresh heartbeat.                                      | heartbeat fresh                                                                          | "online · last seen just now"                                                                |
| `stale`             | Was online; heartbeats lapsed past the freshness window.                     | `NODE_STALE`                                                                             | "stale · last seen <time> — the node may have lost its link"                                 |
| `offline`           | No live link; pair-only or link not running.                                 | `NODE_OFFLINE`                                                                           | "offline — routed sessions unavailable until the node link is running"                       |
| `rotating`          | A next credential was issued; node has not yet proven the new one.           | rotation state machine                                                                   | "rotating credential — old credential still valid until the node confirms"                   |
| `rotation-degraded` | Rotation delivery failed; previous credential remains active.                | `rotation-failed`                                                                        | "credential rotation didn't complete — previous credential is still active. retry rotation." |
| `degraded`          | Reachable but limited: version skew, source-diagnostic warning, or updating. | `helperSkew` (`minor-skew-warn`/`major-skew-error`), source-diagnostic state, `updating` | See [degraded reasons](#degraded-reasons) below                                              |
| `revoked`           | Operator revoked; active links closed, credential rejected.                  | `NODE_REVOKED` (close `4003`)                                                            | "revoked — active links closed, reconnect blocked. local files on the node are not deleted." |
| `re-pair required`  | Credential missing/malformed/mismatched/expired/revoked/incompatible.        | `REPAIR_REQUIRED`, `NODE_CREDENTIAL_*`, `PROTOCOL_INCOMPATIBLE`                          | "re-pair required — run the pair command again. re-pairing creates a new node identity."     |

### Degraded reasons

`degraded` is a human-readable bucket, not a single failure. The node card must name the specific reason in plain language and link to the fix:

- **update recommended** (`minor-skew-warn`): "this node is a few versions behind the hub. update recommended." Sessions still allowed.
- **update required** (`major-skew-error`): "this node is on an incompatible major version. new sessions are blocked until it updates." Maps to the 503 + `Retry-After` drain in `RELAY_NODE_BOOTSTRAP.md`.
- **updating** (`status: updating`): "this node is updating — new sessions are paused while it drains." Temporary.
- **source signal mismatch** (`source-mismatch` / `same-credential-multiple-sources`): "this node connected from an unexpected source. investigate before trusting it." Audit-only by default; strict-deny mode denies. Never expose raw IP/host — only the redacted `displayHint`.

Every degraded reason resolves to an operator action (update / re-pair / investigate / wait), never a dead-end label.

## Node cards by state

Settings → Nodes groups nodes so the operator sees what needs attention first, matching the cockpit attention ordering (`CLI_GATEWAY.md` → cockpit): **needs attention** (pending requests, re-pair required, rotation-degraded) → **degraded** → **offline/stale** → **online**.

Every paired node card shows: display name, trust profile, capability scope (product language), allowed roots (where applicable), last seen, current state + degraded/offline reason, and the controls available in that state. Controls:

- **open terminal / session** — only when the node is online/fresh; disabled with a typed reason otherwise.
- **rotate credential** — operator-initiated rotation.
- **revoke** — closes active links, blocks reconnect (confirmation required; see revoke copy in [Node-side CLI copy](#node-side-cli-copy)).
- **edit access** — changes profile/roots; a capability change, so it routes through re-approval, not a silent edit.
- **install / service instructions** — platform-specific guidance (launchd/systemd/WSL/manual) per `RELAY_NODE_BOOTSTRAP.md`.

Explicit empty/loading/error states are required, especially: hub cannot reach the node, node has never linked (pair-only), and registry read error. None of these may silently render an empty list.

## Node-side CLI copy

The node side is the host running `relay-ide node pair <hub>`. Copy is plain terminal text, redaction-safe (no raw tokens/credentials ever printed). This mirrors the desired output in #979.

**Waiting:**

```text
relay node pairing

device: work-mac
host hint: …book-pro.local
platform: macOS arm64
relay: 0.1.0-nightly.x

open this URL on a signed-in device:
https://relay.company.com/pair/7KQ-M2P

or enter code:
7KQ-M2P

waiting for approval... expires in 10:00
```

If `node pair` prints hostname or source-recognition hints, they follow the same display-metadata rule as the approval card: display names, truncated suffix hints, `sourceFingerprint`, and lossy `displayHint` are allowed; full hostnames, full MagicDNS names, and raw IPs are not.

**Approval (success):**

```text
approved as work-mac
credential stored
node link online
manage this node in Settings → Nodes
```

**Denial:**

```text
pairing denied by operator
no credential was issued
run `relay-ide node pair <hub>` again to request a new code
```

**Expiry:**

```text
pairing request expired (no approval within 10:00)
run `relay-ide node pair <hub>` again to get a fresh code
```

**Credential stored / link online** are the two lines inside the approval block above; they are distinct, ordered signals (credential persisted to `~/.config/relay-ide/node-credential.json` mode 0600, then the reverse link comes up). `node pair` is pair-only — if the operator has not started `relay-ide node link --hub <hub>`, the CLI says so:

```text
credential stored
node is paired but the link is not running
start it with: relay-ide node link --hub https://relay.company.com
```

**Revoke / re-pair** (node-side; revocation is always hub-driven — there is no `node unpair` command):

```text
node link closed: NODE_REVOKED
this node was revoked by the hub. it cannot reconnect with the old credential.
to use this machine again, re-pair it: relay-ide node pair <hub>
remove the old credential first: rm ~/.config/relay-ide/node-credential.json
```

Hub-side revoke confirmation copy (Settings → Nodes):

> Revoking this node closes active links and blocks reconnect. Local files on that machine are not deleted. Re-pairing requires a new operator approval and creates a new node identity.

**Service / install guidance** (for a brand-new host or when setting up persistence):

```text
to keep this node linked across reboots, install it as a service:
  macOS:        relay-ide node install --hub <hub> --service launchd
  linux:        relay-ide node install --hub <hub> --service systemd-user
  wsl2 systemd: relay-ide node install --hub <hub> --service wsl-systemd
  wsl2 manual:  relay-ide node install --hub <hub> --service wsl-manual
  any platform: relay-ide node install --hub <hub> --service manual

then hold the link:
  relay-ide node link --hub <hub>
```

All CLI output passes through redaction (`redactBootstrapSecrets()` in `shared/bootstrap-diagnostics.ts`): no `pair_…`, `secret_…`, `node_…secret_…`, or `Bearer …` material is ever printed in cleartext.

## Command Center parity

Command Center exposes node actions as searchable actions, but it **projects shared command/action descriptors and routes into the same Settings → Nodes flows or stable gateway commands.** It must never become a second pairing implementation or a private React-only handler (`CLI_GATEWAY.md` → action parity rule, `FRONTEND.md` → action-contract parity).

Node action family (Command Center search entries):

- add node
- copy pair command
- show pending node requests
- approve node request
- deny node request
- edit node access
- open terminal on node
- rotate node credential
- revoke node
- show install instructions

Candidate stable command family these actions project from (per #979; final ids land with #982/#985/#986):

```text
relay-ide v1 nodes.list --json
relay-ide v1 nodes.pair.request --json
relay-ide v1 nodes.pair.status --json
relay-ide v1 nodes.pair.approve --json
relay-ide v1 nodes.pair.deny --json
relay-ide v1 nodes.revoke --json
relay-ide v1 nodes.rotateCredential --json
relay-ide v1 nodes.installInstructions --json
```

Parity requirements carried into #985/#986:

- Add/change the stable command descriptor first (`shared/cli-gateway-contract.ts` → `shared/relay-command-manifest.ts` → `shared/action-descriptor.ts`), then project to Command Center and web UI.
- Until a real UI execution bridge exists, manifest-only entries stay disabled/degraded in the palette and point to the stable CLI argv (matching the existing command-taxonomy rule).
- UI-only helpers (e.g. opening the wizard dialog, list sorting) stay explicitly marked UI-only.
- Drift tests fail loudly if a public node action exists in web/CLI/docs but is missing from the action descriptor / Command Center projection without an explicit UI-only/private annotation.

## Mobile / narrow-screen behavior

Two surfaces must work on a phone-width screen.

### Settings → Nodes (narrow)

- Node cards stack vertically; the attention grouping order is preserved (needs-attention first).
- Each card collapses secondary metadata (roots, fingerprint, full source signal) behind a "details" disclosure; state, name, profile, and the primary action stay visible without expanding.
- Destructive controls (revoke) keep their confirmation step on touch; no swipe-to-revoke without confirm.
- The Add Node wizard renders as a full-screen stepped flow on narrow screens (one step per screen), not a cramped modal.

### Device-code approval route (`/pair/<code>`)

This is the route an operator opens on a signed-in device — frequently a phone — to approve a waiting node.

- **enter code:** a large, touch-friendly single field that accepts the device code (e.g. `7KQ-M2P`); case-insensitive, dash-tolerant. The route also accepts the code in the path (`/pair/7KQ-M2P`) so a copied URL lands directly on the matching request.
- **pending-request card:** the full redaction-safe approval card from above, laid out vertically; the warning copy is always visible above the fold.
- **approve / deny / edit:** large touch targets. `edit access` (profile/roots) is reachable but may be simplified to profile selection on the narrowest widths, with full root editing deferred to the desktop Settings → Nodes surface.
- **stronger approval ceremony:** when an `infra / prod host` approval requires the exact-operation confirmation, the mobile route must surface that challenge clearly rather than silently approving; if the device cannot complete the ceremony, it says so and points to the desktop path.
- Signed-in requirement: the route is behind the browser-session lane. An unauthenticated visitor sees the login/PIN gate, not request details. The device code alone never reveals request contents to an unauthenticated viewer.

## Redaction rules

Every surface in this spec — CLI output, node cards, approval cards, Command Center descriptions, audit, screenshots, and issue comments — follows the redaction contract in `SECURITY_POLICY.md` and `RELAY_NODE_BOOTSTRAP.md`.

**Safe to show:** `nodeId`, `credentialId`, `rotationId`, lifecycle state, recovery reason code, source-diagnostic `state`/`policy`/`reasonCode`/`observedAt`, stable `sourceFingerprint` (`src_<hex>`), lossy `displayHint`, truncated public-key fingerprint, trust tier/profile (product language), capability posture (product language), redacted scope/params hashes, display names, timestamps.

**Never show:** raw pair tokens, raw node credential tokens or token hashes, browser cookies, confirmation tokens, scoped actor bearer material, operator grant handles, raw forwarded headers, raw env values, file bytes, terminal byte streams, full path inventories, full hostnames, full MagicDNS names, raw tailnet IPs, raw capability-bit ACL internals in customer-facing copy, or any secret-looking string.

Redaction is **acceptance, not polish.** Any path that leaks the "never show" set into copy, logs, diagnostics, screenshots, or command descriptions fails this spec.

## QA screenshot / mock evidence

QA validates this UX against the happy path plus the denied/expired/revoked/offline states. Lightweight mocks (static screens or a mocked hub) are acceptable for the spec/UI slices; the dogfood lane (#987) provides the real end-to-end evidence.

Expected evidence:

| Evidence                    | Pass signal                                                                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add Node wizard walkthrough | Screens for each step (node type → profile/roots → pair command + device code → incoming request → approve/deny/edit → post-approval next action).                                                                          |
| Device-code CLI transcript  | `relay-ide node pair <hub>` shows device name/platform/version, device-code URL + code, expiry countdown, waiting, then approval (`approved as … / credential stored / node link online`). No secrets or raw tokens appear. |
| Pending-request card        | Shows the redaction-safe field set, requested profile/capabilities (product language), source signal, expiry, fingerprint, and the warning copy.                                                                            |
| State coverage              | Screens/mocks for pending, approved, denied, expired, online, stale, offline, rotating, rotation-degraded, degraded (each reason), revoked, and re-pair-required.                                                           |
| Trust-profile copy          | Each profile shows its `can:` / `never:` lines; `infra / prod host` shows the stronger-approval notice.                                                                                                                     |
| Mobile / narrow             | Settings → Nodes stacked cards and the `/pair/<code>` approval route on phone width, including the always-visible warning copy.                                                                                             |
| Command Center parity       | The node action family is searchable and routes into Settings → Nodes / stable gateway commands; no bespoke pairing handler.                                                                                                |
| Redaction proof             | No raw grants, credentials, cookies, pair tokens, IPs, or full hostnames in any screenshot, transcript, audit row, or command description.                                                                                  |

> Epic-level note: the full #979 epic is QA'd once it ships. This spec slice runs only the doc/build/check verification appropriate to the changed files; it does not claim or open a QA gate for the whole epic.

## Open decisions for downstream tickets

These are deliberately left to implementation planning and are not resolved by this spec:

- Final stable command ids and input/output schemas for the `nodes.pair.*` family (#982/#985/#986).
- Whether the device-code wait uses long-poll, short-poll, or a held pairing channel (#983) — copy here is transport-agnostic.
- Exact freshness windows for `online`/`stale`/`offline` thresholds (#982/#984) — reuse the existing heartbeat/skew windows in `RELAY_NODE_BOOTSTRAP.md` rather than inventing new ones.
- The precise stronger-approval ceremony for `infra / prod host` beyond the current #807 exact-operation confirmation (passkey/WebAuthn/TOTP remain future work).
- Reclaim path for a revoked/lost node identity (out of scope for the first slice; default is a new identity).

## See also

- [`RELAY_NODE_BOOTSTRAP.md`](RELAY_NODE_BOOTSTRAP.md) — pairing/install/update/unpair runbook, lifecycle states, source diagnostics, redaction, service setup.
- [`SECURITY_POLICY.md`](SECURITY_POLICY.md) — auth lanes, node identity lifecycle, trust tiers, capability bits, exact-operation approval, redaction.
- [`OPERATOR_HANDSHAKE_GRANTS.md`](OPERATOR_HANDSHAKE_GRANTS.md) — one-time operator grant ceremony, the node pair-token mint lane, lane separation.
- [`CLI_GATEWAY.md`](CLI_GATEWAY.md) — versioned command contract, command taxonomy, web UI action-parity rule.
- [`FRONTEND.md`](FRONTEND.md) — Command Center / action registry, action-contract parity rule.
- [`../DESIGN.md`](../DESIGN.md) — visual language: lowercase labels, terracotta accent, semantic status colors, no emoji icons.
