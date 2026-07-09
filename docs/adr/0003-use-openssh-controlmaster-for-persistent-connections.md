# Use OpenSSH ControlMaster for Persistent Connections

Status: superseded by ADR-0009

AI SSH will keep first-version SSH access stable by creating and reusing OpenSSH ControlMaster connections with app-managed control paths and explicit close behavior. This avoids repeated authentication for routine commands and transfers, reduces server-side login events that can trigger rate limits, and preserves compatibility with local OpenSSH configuration; the app will layer health checks and recovery UX over the underlying master connection.
