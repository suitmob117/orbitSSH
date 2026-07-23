# Store Redacted Local Session History

OrbitSSH will keep local session history so AI-assisted work can remain contextual across actions, but it will store summaries and truncated output by default rather than long-lived full command output. Full output persistence must be explicit because remote server responses often contain credentials, tokens, private configuration, or other sensitive operational data.
