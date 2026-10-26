---
name: quiet-run
description: Run a build, test suite or other noisy command with its full output saved to a log file, and bring back only the exit code, the errors and the last lines. Use instead of running long builds or tests directly.
argument-hint: <command>
---

Run the command in $ARGUMENTS without flooding the conversation with its output.

1. Send all output to a log file and keep the exit code. Use the session's scratchpad folder if there is one, otherwise the system temp folder:

   ```sh
   log="${TMPDIR:-/tmp}/quiet-run-$(date +%s).log"
   ( <command> ) >"$log" 2>&1; status=$?
   echo "exit $status, $(wc -l <"$log" | tr -d ' ') lines in $log"
   ```

2. If it passed, say so in one line with the log path.
3. If it failed, show only what explains the failure: `grep -nEi 'error|fail|exception|panic' "$log" | head -n 40`, then `tail -n 30 "$log"`. Read more of the log in line ranges only when that is not enough.
4. Never print the whole log.
