# Orchestrate Local OpenSSH

Status: superseded by ADR-0009

AI SSH will make first-version connections by orchestrating the operator's local OpenSSH tools from Electron's main process. This keeps behavior aligned with existing SSH config, keys, agents, known hosts, ProxyJump, and port-forwarding support; Node SSH libraries can be added later only where the app needs structured capabilities that OpenSSH process orchestration cannot provide cleanly.
