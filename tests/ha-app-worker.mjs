// Isolated real application process. IPC is test-only fault injection, never an HTTP route.
import { createApp } from '../src/server.mjs';

const app = await createApp(JSON.parse(process.env.HA_TEST_OPTIONS));
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
process.send({ event: 'ready', endpoint: `http://127.0.0.1:${app.server.address().port}` });
let releaseCommit;
process.on('message', async message => {
  try {
    let result;
    if (message.command === 'armCommitBarrier') {
      const original = app.ha.exportState;
      app.ha.exportState = async () => {
        app.ha.exportState = original;
        const state = await original();
        await new Promise(resolve => { releaseCommit = resolve; process.send({ event: 'commitBarrier' }); });
        return state;
      };
    } else if (message.command === 'releaseCommit') {
      releaseCommit?.(); releaseCommit = null;
    } else if (message.command === 'inspectProjection') {
      result = { users: app.auth.listUsers().map(user => user.username), ha: app.ha.status() };
    } else throw new Error('Unknown test command');
    process.send({ id: message.id, ok: true, result });
  } catch (error) { process.send({ id: message.id, error: error.message }); }
});
