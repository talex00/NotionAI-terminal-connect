# Security

This project intentionally lets a remote AI execute commands as your local Linux user. Treat the generated bearer token like a temporary password.

## Security model

- The MCP server binds to `127.0.0.1` only.
- A new random bearer token is generated on every launch.
- The public URL is a temporary Cloudflare Quick Tunnel.
- File tools reject paths that escape the selected workspace, including escapes through existing symlinks.
- Terminal commands start in the workspace, but are **not a filesystem sandbox**. They have the same permissions as the user who started the bridge.
- Managed command process groups are terminated when the server stops. A deliberately detached process can escape process-group cleanup, so do not treat this as containment against malicious commands.

## Recommendations

- Run the bridge as an unprivileged user; never use `sudo ./start.sh`.
- Use a dedicated project directory with no secrets.
- Do not paste the token into chats, logs, issues, or commits.
- Stop the bridge immediately after the coding session.
- For stronger isolation, run this project inside a disposable VM or container and mount only the project directory.

## Reporting a vulnerability

Please open a private GitHub security advisory for the repository instead of publishing credentials or exploit details in a public issue.
