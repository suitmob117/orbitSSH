# Store Secrets in the OS Credential Vault

OrbitSSH may save SSH passwords and key passphrases for local convenience, but secrets must be stored in the operating system credential vault rather than app configuration, logs, SQLite rows, or session history. Connection profiles may reference saved credentials by ID so the app can reconnect without repeated password prompts while keeping plaintext secrets out of normal project data.
