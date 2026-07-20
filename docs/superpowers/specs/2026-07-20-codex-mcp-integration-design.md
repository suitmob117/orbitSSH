# Codex MCP Integration Design

## Goal

Register AI SSH as a local Codex MCP server while ensuring the server-side authorization level is not merely descriptive. The integration must use the production build, retain the operating-system credential vault, and expose only the intended MCP tools.

## Scope

This change covers:

- server-side enforcement for `auto_readonly` connection sessions;
- conservative command classification for automatic read-only execution;
- matching enforcement for file transfers;
- a production MCP build and Codex MCP registration;
- automated policy tests and an end-to-end MCP smoke test.

It does not add new SSH authentication methods, jump-host support, remote HTTP transport, or a new user interface.

## Authorization Behavior

AI SSH remains responsible for enforcing the session authorization boundary. Codex remains responsible for asking the operator to approve MCP tool calls.

- `auto_readonly`: the server accepts commands classified as read-only, accepts downloads, and rejects commands with ambiguous or write behavior and all uploads.
- `ask_every_time`: the server accepts the requested action after Codex has approved the MCP tool call. The Codex configuration therefore keeps command execution and file transfer tools in prompt mode.
- `trusted_session`: the server accepts commands and transfers after the operator explicitly opens a trusted session.

Automatic read-only classification is deliberately conservative. Commands containing shell chaining, pipelines, command substitution, redirection, or newlines are treated as non-read-only even if their first token looks harmless. This avoids a partial shell parser and prevents a safe-looking prefix from hiding a write operation.

Rejected actions return a clear error before opening an SSH command channel or starting an SFTP transfer.

## Components

`src/core/command-policy.ts` owns pure authorization decisions. It will expose policy checks that combine the existing risk assessment with the selected authorization level and transfer direction.

`src/core/ssh-session-manager.ts` applies those checks at the execution boundary before calling SSH or SFTP.

Tests exercise the pure policy functions using Node's built-in test runner so the project does not need another test framework. Package scripts provide focused and full test commands.

The Codex configuration launches the built `dist/mcp/server.js` with the current Node executable. The configuration enables only profile listing, session lifecycle, health, command execution, and bounded upload/download tools. Read-only discovery and health tools may run automatically; connection creation, commands, transfers, and session closure require MCP approval.

## Error Handling

Policy rejection errors identify the authorization level and explain that the operator must use an appropriately approved session. No remote action is attempted after rejection.

Build or MCP startup failures leave the existing Codex configuration untouched. Before registration, the current Codex configuration is backed up. Registration is verified through Codex's MCP listing and by calling `list_connection_profiles` through the built stdio server.

## Verification

The implementation is complete only when all of the following pass freshly:

1. Policy tests demonstrate read-only acceptance and ambiguous/write rejection, including compound commands and upload/download behavior.
2. Type checking passes.
3. The full production build succeeds.
4. Codex parses and lists the `ai_ssh` MCP entry.
5. A real MCP client starts the production server and successfully calls `list_connection_profiles` without exposing stored secret values.
