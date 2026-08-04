# Agent view artifacts

Agent view artifacts are agent-authored, static HTML/CSS packages stored in the WorkContext artifact store. They are for evidence dashboards and summaries that need richer layout than markdown while keeping the render path read-only and isolated.

## Contract

Publish through the WorkContext artifact route with a `viewArtifact` package instead of a pipeline `artifact`:

```http
POST /work-context-artifacts
Content-Type: application/json
x-relay-capabilities: context:write

{
  "workContextId": "wc:...",
  "viewArtifact": {
    "manifest": { "kind": "relay.agentView", "schemaVersion": 1, "...": "..." },
    "files": { "index.html": "<main>...</main>", "style.css": "main { ... }" }
  },
  "pin": true
}
```

CLI equivalent:

```bash
relay-ide v1 work-context-artifacts publish \
  --work-context-id wc:example \
  --view-file ./relay-view-package.json \
  --json
```

Successful publishes are normal WorkContext artifact rows with `metadata.payloadKind: "agent-view-artifact"`, a SHA-256-addressed JSON payload file, and the manifest revision id as the artifact id. The authenticated viewer package route is:

```http
GET /work-context-artifacts/:id/view-package
x-relay-capabilities: context:read
```

It returns `{ artifact: { metadata, viewArtifact } }` and uses the same auth lane as `GET /work-context-artifacts/:id`.

## Package shape

A package is a JSON object:

```ts
interface ViewArtifactPackage {
  manifest: AgentViewManifest;
  files: Record<string, string>; // relative path -> UTF-8 HTML/CSS text
}
```

### Manifest schema

Required manifest fields:

| Field | Required value / meaning |
| --- | --- |
| `kind` | Literal `relay.agentView`. |
| `schemaVersion` | Literal `1`. |
| `title` | Human-readable title, <= 200 chars. |
| `description` | Optional summary, <= 2000 chars. |
| `entry` | Relative `.html` path present in `files`. |
| `authoring.actorId` | Agent/system actor id that authored the view. |
| `authoring.harness` | Optional authoring harness name. |
| `createdAt`, `updatedAt` | Strict ISO timestamps. |
| `scope.repo` | Optional owner/repo or project scope string. |
| `scope.taskRefs[]` | Related task refs (`kind`, `id`, optional title/url/status). |
| `sources[]` | Source evidence with `label`, `url`, optional `capturedAt`, optional `kind`. |
| `capabilities` | Must be `[]` in the MVP. |
| `export.policy` | `private` or `public`; private is the default storage visibility unless overridden. |
| `revision.id` | Artifact id used by storage. |
| `revision.supersedes` | Optional previous WorkContext artifact id. |

Files must use safe relative paths, no `..`, no absolute paths, no backslashes, no whitespace/control chars, and extensions limited to `.html` and `.css`.

## Size and validation caps

| Cap | Value |
| --- | ---: |
| Total view package file bytes | 512 KiB |
| Per-file bytes | 64 KiB |
| File count | 16 |
| Publish payload cap | Also subject to the generic WorkContext artifact publish cap after the view cap. |

Publish-time validation rejects `<script>`, inline `on*=` handlers, `javascript:` URIs, and `<iframe>`, `<object>`, or `<embed>` tags in HTML. This is defense in depth; the render sandbox is the primary security control.

## Security model

Treat every byte as hostile. The only sanctioned browser render path is an iframe using `srcDoc` with an empty sandbox attribute: `sandbox=""`. Do not add `allow-scripts`, `allow-same-origin`, or a fetchable `src=` URL. The assembled document injects a CSP meta tag:

```text
default-src 'none'; style-src 'unsafe-inline'; img-src data:
```

The package read route is authenticated and private to Relay. Public export intentionally omits HTML/CSS file bytes; it returns a public summary with sanitized manifest text only. Manifest text is redacted for secret-looking tokens, local absolute paths, and private Kanban task ids. HTML/CSS bytes are not sanitized for public export because they are not included.

## Denied capabilities

The MVP allows no runtime capabilities from the artifact package.

| Requested capability | Status | Reason |
| --- | --- | --- |
| `script` / JavaScript execution | Denied | Empty iframe sandbox and validation reject scripts/handlers. |
| `network` / remote fetch | Denied | CSP uses `default-src 'none'`; no runtime grant exists. |
| `same-origin` / parent access | Denied | Empty sandbox does not grant same-origin or parent access. |
| `storage` / cookies / localStorage | Denied | Empty sandbox isolates storage/cookies. |
| `forms` / navigation / popups | Denied | No sandbox allowances are granted. |
| Relay API calls | Denied | Artifacts are static bytes, not protocol clients. |
| File system, shell, git, node RPC | Denied | WorkContext artifacts store evidence only. |

Any non-empty `manifest.capabilities` array fails validation.

## Dogfood steps

1. Create a package JSON with a manifest and `index.html`/`.css` files.
2. Validate locally with the shared contract tests or by publishing to a dev hub.
3. Publish:
   ```bash
   relay-ide v1 work-context-artifacts publish --work-context-id <wc-id> --view-file ./package.json --json
   ```
4. Confirm the response has `metadata.payloadKind: "agent-view-artifact"`, the expected revision id, and a SHA-256.
5. Read the authenticated package route for viewer integration:
   ```bash
   curl -H 'x-relay-capabilities: context:read' \
     http://127.0.0.1:3456/work-context-artifacts/<artifact-id>/view-package
   ```
6. If `export.policy` is `public`, verify `/work-context-artifacts/:id/export` contains the sanitized manifest and does not contain `files` or HTML/CSS bytes.
