# Gobare Tools

Local-only Gobare tooling. This repository owns the `gobare` CLI and must not contain Console,
server, KeyVault, or cloud session restore logic.

## Development

```bash
pnpm install
pnpm build
node dist/cli.js pi inspect --session <pi-session-id>
```

`pi inspect` accepts a stopped local Pi session, copies it to a temporary directory, validates the
opaque JSONL through Pi's native `SessionManager.open()`, and prints metadata only.

## Import a stopped Pi project

Create a least-privilege token in Gobare Console under **Settings > Developer access**, then:

```bash
gobare auth login --token gbr_pat_...
gobare pi import --session <exact-pi-session-uuid> --name "Checkout flow debugging" --workspace . --include-env
```

The command creates a new Gobare project only. It copies and validates the stopped Pi JSONL,
captures portable workspace state (Git bundle, patches, untracked files, or a source snapshot),
and uploads encrypted payloads. It never copies model, Git, SSH, OAuth, or integration credentials,
and does not start a cloud host or call a model. Open the returned project URL, choose a Gobare
model, then use **Continue in Gobare**.

`--include-env` is required when the project contains `.env*` files. It imports only explicitly
approved application runtime variables into a project-only Environment profile; control-plane
credential names are rejected. Without `--include-env`, the command stops rather than silently
claiming a complete environment migration.
