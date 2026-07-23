# Expose a Local MCP Server for AI Clients

OrbitSSH will expose its SSH capabilities to local AI clients through a local MCP server instead of embedding model-provider configuration in the desktop app. This keeps AI credentials and model selection owned by the calling AI tool while OrbitSSH owns connection profiles, persistent SSH sessions, authorization levels, command execution, file transfer, and session health.
