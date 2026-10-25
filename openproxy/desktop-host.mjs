import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const started = performance.now();
const progress = stage => send({ event: 'startup', stage, elapsedMs: Math.round(performance.now() - started) });
let controller, UserError;
try {
  progress('modules');
  const storeModule = await import('./lib/store.mjs');
  const { Store } = storeModule;
  UserError = storeModule.UserError;
  const { DesktopController } = await import('./lib/desktop-controller.mjs');
  progress('localState');
  controller = new DesktopController(await new Store().init());
} catch (error) {
  send({ event: 'fatal', error: UserError && error instanceof UserError ? error.message : 'Cannot initialize local desktop state.' });
  process.exit(1);
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
input.on('line', line => {
  // Ordered commands prevent overlapping start/stop/login actions. A login
  // begins asynchronously, so status/cancellation remain available.
  queue = queue.then(async () => {
    let request;
    try {
      if (line.length > 16_384) throw new UserError('Desktop request too large.');
      request = JSON.parse(line);
      if (!Number.isSafeInteger(request.id) || typeof request.method !== 'string') throw new UserError('Invalid desktop request.');
      if (request.method === 'shutdown') {
        await controller.close(); send({ id: request.id, result: { closed: true } }); input.close(); return;
      }
      send({ id: request.id, result: await controller.dispatch(request.method, request.args) });
    } catch (error) {
      send({ id: request?.id ?? null, error: error instanceof UserError ? error.message : 'Desktop operation failed. Check local state and engine installation.' });
    }
  });
});
input.once('close', () => { queue.finally(() => controller.close()).finally(() => process.exit(0)); });
process.once('SIGTERM', () => controller.close().finally(() => process.exit(0)));
progress('ready');
