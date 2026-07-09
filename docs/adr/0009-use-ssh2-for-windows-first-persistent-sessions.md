# Use ssh2 for Windows-First Persistent Sessions

AI SSH will use the Node `ssh2` library for first-version persistent SSH sessions instead of relying on OpenSSH ControlMaster. The product's main requirement is stable reuse without repeated authentication on the user's Windows desktop, and Windows OpenSSH multiplexing is not reliable enough to be the first-version foundation; `ssh2` provides one long-lived authenticated connection that can run commands, SFTP transfers, and interactive shell channels.
