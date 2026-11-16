/**
 * Windows launcher for background agy tasks: `node bgLauncher.js <cmd> [args…]`.
 *
 * On Windows a background task needs two things that one spawn can't give:
 *  - survive the MCP server exiting. Node puts every non-detached child into a
 *    job object that is killed when the server exits, so the task must be
 *    spawned `detached` (DETACHED_PROCESS);
 *  - no console windows. A DETACHED_PROCESS child has no console, so every
 *    console program agy starts for a tool command (PowerShell) opens its own
 *    visible window, and `windowsHide` is ignored together with DETACHED_PROCESS.
 *
 * So bgTaskManager spawns this launcher detached, and the launcher spawns agy
 * non-detached with `windowsHide`: agy, having no console to inherit, gets a
 * new one whose window is hidden (SW_HIDE), and its children share it. stdio
 * is passed straight through and the launcher exits with agy's exit code, so
 * the task's files and exit status are the same as when agy is spawned
 * directly. agy (but not its own children) sits in the launcher's job object,
 * so it goes down with the launcher.
 */
import spawn from "cross-spawn";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  process.stderr.write("bgLauncher: missing command\n");
  process.exit(2);
}

const child = spawn(command, args, { stdio: "inherit", windowsHide: true });

child.on("error", (err) => {
  // stderr is the task log — leave the reason there. 127 = command not found.
  process.stderr.write(`Failed to start ${command}: ${err.message}\n`);
  process.exit(127);
});

child.on("exit", (code, signal) => {
  if (code !== null) process.exit(code);
  if (signal) process.kill(process.pid, signal);
  process.exit(1);
});
