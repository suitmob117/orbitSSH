# Use Conservative Reconnection

OrbitSSH will not silently retry failed SSH logins in a tight loop when a persistent connection is lost. The app will show session health, perform lightweight checks before remote work, and require an explicit operator reconnect when authentication or the master connection has failed, because repeated automatic login attempts can trigger server-side rate limits.
