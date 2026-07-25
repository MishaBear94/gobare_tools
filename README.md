# Gobare Tools

Local-only Gobare tooling. This repository owns the `gobare` CLI and must not contain Console,
server, KeyVault, or cloud session restore logic.

For the complete user-facing flow from a stopped local Pi session to a restored Gobare project,
including environment variables, automatic cloud restore, retry, and export, see
[Pi Project Import User Journey](./docs/Pi-Project-Import-User-Journey.md).

## Development

```bash
pnpm install
pnpm build
node dist/cli.js pi inspect --session <pi-session-id>
```

## Verified release package

The current distributable is a portable **Node.js 22+ package**, not a standalone native binary.
That distinction is intentional: the release name and install instructions never imply that a
Node runtime is bundled. GitHub releases are created only from `tools-v*` tags, include a
`SHA256SUMS` manifest, and carry GitHub build provenance attestation.

Download the `.tgz` and `SHA256SUMS` from the matching release, then verify before installing:

```bash
sha256sum --check SHA256SUMS
npm install --global ./gobare-tools-<version>.tgz
gobare --help
```

On macOS, use `shasum -a 256 -c SHA256SUMS` when GNU `sha256sum` is not installed. To verify the
signed GitHub provenance as well, use `gh attestation verify <artifact>.tgz --repo MishaBear94/gobare_tools`.
The package requires Node 22 or newer. Native macOS/Linux binaries remain a separate release gate
and must not be substituted with a mislabeled archive.

`pi inspect` accepts a stopped local Pi session, copies it to a temporary directory, validates the
opaque JSONL through Pi's native `SessionManager.open()`, and prints metadata only.

`gobare pi import` is intentionally a stopped-session migration. Finish or cancel any pending
Pi follow-up/steering messages before exiting Pi: those queues live only in the active Pi
`AgentSession` process and are not part of the native JSONL, so Gobare never attempts to infer,
replay, or persist them.

## Import a stopped Pi project

Create a least-privilege token in Gobare Console under **Settings > Developer access**, then:

```bash
# Recommended: avoid placing the token in shell history.
printf '%s' "$GOBARE_TOKEN" | gobare auth login --token
gobare pi import --session <exact-pi-session-uuid> --name "Checkout flow debugging" --workspace . --include-env
```

`gobare auth login --token` reads the token from standard input. `GOBARE_TOKEN` is also accepted
for non-interactive automation and is never persisted unless login succeeds. The legacy
`--token <value>` form remains supported for compatibility but is not recommended because shell
history may retain the value.

The command creates a new Gobare project only. It copies and validates the stopped Pi JSONL,
captures portable workspace state (Git bundle, patches, untracked files, or a source snapshot),
and uploads encrypted payloads. It never copies model, Git, SSH, OAuth, or integration credentials,
and does not call a model. Open the returned project URL to follow the automatic cloud restore.
Gobare restores the workspace, native Pi checkpoint, and visible history without a model; connect
a model only when you send the next AI task.

Before a project is created, the CLI scans the copied opaque Pi JSONL for credential-shaped values
and stops with a stable policy code if it finds one. Gobare applies the same check again before
encrypting and storing the payload. The scan never rewrites the Pi session or prints matched text.

`--include-env` is required when the project contains `.env*` files. It imports only explicitly
approved application runtime variables into a project-only Environment profile; control-plane
credential names are rejected. Without `--include-env`, the command stops rather than silently
claiming a complete environment migration.

Use `--dry-run` to validate the local Pi session, portable workspace payload, opted-in environment
configuration, and the scoped Gobare token without creating a project, transfer, upload, retry
journal, sandbox, or model request. Its JSON output contains only IDs, counts, checksums and file
state summaries, never source content or environment variable values.

After a normal preflight, the CLI prints a concise non-sensitive summary and asks before creating
the cloud project. Automation must use both `--json --yes`; `--json` without `--yes`, or a
non-interactive import without `--yes`, stops before a journal or remote project is created.

For a resumable normal import, the private retry journal records the stable transfer and
created-project IDs, manifest checksum, creation time, and local Pi/workspace references needed to
rebuild the same payload. The project ID is written before payload upload begins so an interrupted
upload can be resumed or safely cleaned up without guessing by name. The journal never contains the
CLI token, JSONL, workspace archive, environment values, or other credentials.

To resume an interrupted upload without creating another project, run:

```bash
gobare pi import resume <transfer-id> --json --yes
```

The command reads only its existing local retry journal, re-validates the same stopped Pi session
and portable workspace, verifies the original manifest checksum, then uploads to that exact
transfer. A changed local session, workspace, environment payload, or configured Gobare server is
rejected instead of being silently applied to the prior project.

## Export a restored Pi session

For a completed imported project, use its Gobare project ID. The transfer ID returned by
`gobare pi import` remains supported for automation and recovery:

```bash
gobare pi export --project <project-id> --output ./restored-pi-session.jsonl
```

The CLI downloads only your own completed import's latest encrypted Pi checkpoint. It writes with
exclusive-create semantics by default, then uses the local Pi `SessionManager.open()` to validate
the downloaded JSONL before reporting success. Use `--force` only when you deliberately intend to
replace the output path.
