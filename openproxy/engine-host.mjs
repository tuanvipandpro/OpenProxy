// Own the native engine behind an IPC lifetime channel. If the main proxy is
// killed, Node closes this channel and this host terminates its engine too.
import { spawn } from 'node:child_process';

const engine = spawn(process.argv[2], process.argv.slice(3), {
  env: process.env, stdio: 'ignore', windowsHide: true,
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  engine.kill();
  setTimeout(() => process.exit(1), 3000).unref();
}
engine.once('error', () => process.exit(1));
engine.once('exit', code => process.exit(stopping ? 0 : (code || 1)));
process.on('disconnect', stop);
process.on('message', message => { if (message === 'shutdown') stop(); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (process.connected) process.send({ enginePid: engine.pid });
