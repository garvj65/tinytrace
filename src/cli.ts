import { createIngest } from './server.js';
const { server } = createIngest();
server.on('error', err => { console.error(err.message); process.exitCode = 1; });
server.listen(4318, '127.0.0.1', () => console.log('tinytrace ingest: http://127.0.0.1:4318/events'));
