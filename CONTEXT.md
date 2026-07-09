# AI SSH

AI SSH is a desktop-oriented SSH operations tool for making remote server access easier, safer, and more recoverable for an AI-assisted operator.

## Language

**AI-first SSH Tool**:
A tool designed around an AI-assisted operator performing SSH-related work through guided, inspectable actions rather than raw terminal sessions.
_Avoid_: SSH wrapper, terminal replacement

**Remote Server**:
A host that the operator connects to over SSH to inspect, configure, or modify files and processes.
_Avoid_: Machine, box, node

**Connection Profile**:
A saved description of how to connect to a remote server, including host identity and authentication references.
_Avoid_: Host config, server entry

**Authentication Prompt**:
A one-time operator interaction used to complete SSH authentication when no saved credential or local key can complete the connection.
_Avoid_: Login form

**Saved Credential**:
A password or passphrase stored in the operating system credential vault and referenced by AI SSH without writing the secret into app configuration.
_Avoid_: Plaintext password, config secret

**Authorization Level**:
The operator-selected policy that controls which AI-proposed remote actions can run automatically and which require explicit approval.
_Avoid_: Permission mode, safety setting

**Local AI Client**:
An AI assistant running on the operator's computer that asks AI SSH to perform remote server actions without configuring model credentials inside AI SSH.
_Avoid_: Built-in AI, hosted agent

**Tool Interface**:
The local, controlled entry point that lets a local AI client use AI SSH's connection sessions, command execution, file transfer, and health checks.
_Avoid_: API backend, model provider

**Session History**:
The local record of actions, commands, outcomes, summaries, and selected output from a connection session.
_Avoid_: Audit log, chat history

**Connection Session**:
An active working context created from a connection profile, holding the live connection state and the operator's SSH-related activity for that remote server.
_Avoid_: Terminal tab, login

**File Transfer**:
A bounded upload or download between the operator's computer and a remote server, shown with source, destination, and overwrite risk before execution.
_Avoid_: File manager, sync

**Session Terminal**:
An interactive terminal panel inside a connection session for manual takeover, authentication edge cases, and commands that require a TTY.
_Avoid_: Main interface, terminal emulator product

**Persistent Connection**:
A connection that stays reusable after authentication until the operator or app explicitly closes it, so later commands and transfers do not trigger repeated logins.
_Avoid_: Auto reconnect, one-shot connection

**Session Health**:
The visible state of a connection session, indicating whether it is connected, degraded, or disconnected before the operator runs more remote work.
_Avoid_: Online status, ping result

**Local Desktop App**:
An application installed and run on the operator's own computer so it can use local SSH configuration, keys, files, and long-running connection processes.
_Avoid_: Web app, hosted app
