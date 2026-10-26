---
name: dev-server
description: Start, restart or stop a local development server in the background with its output in a log file, and wait until it answers. Use instead of running servers in the foreground or killing ports by hand.
argument-hint: start|restart|stop <port> [command]
---

Manage a dev server without blocking the session or flooding it with logs. $ARGUMENTS gives the action, the port and, to start, the command. With no port, use `$WORKFLOW_PORT_BASE`, this session's own port, and say which one you picked.

- Log file: `${TMPDIR:-/tmp}/dev-server-<port>.log`.
- Free the port: `pids=$(lsof -ti tcp:<port> 2>/dev/null); [ -n "$pids" ] && kill $pids`. Where lsof is missing (some Linux machines), use `fuser -k <port>/tcp`.
- Start: free the port, then run the command with the Bash tool's run_in_background option and all output going to the log: `<command> >"$log" 2>&1`.
- Wait until it answers: `curl -s -o /dev/null --retry 60 --retry-delay 1 --retry-connrefused "http://127.0.0.1:<port>/"`. If it never answers, show `tail -n 40 "$log"` and stop.
- Restart: stop, then start. Stop: free the port and check that nothing listens on it.

Reply in one line with the URL or the error from the log. When asked about server errors, read the log with tail or grep, never the whole file.
