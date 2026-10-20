import { once } from 'node:events';
import { createIngest } from '../dist/server.js';
import { init, captureException, captureMessage, setTag, addBreadcrumb, close } from '../dist/index.js';

const { server, groups } = createIngest();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
init({ endpoint: `http://127.0.0.1:${server.address().port}/events`, environment: 'demo', batchSize: 3 });
console.log('tinytrace | zero runtime dependencies | real local HTTP');
setTag('service', 'checkout');
addBreadcrumb({ category: 'cart', message: 'Clicked Pay' });
function checkout() { try { throw new TypeError('Payment provider unavailable'); } catch (err) { captureException(err); } }
checkout(); checkout();
captureMessage('Checkout demo completed');
const delivered = await close();
await new Promise(resolve => server.close(resolve));
console.log(`Delivered: ${delivered} | Groups: ${groups.size} | Events: ${[...groups.values()].reduce((a, b) => a + b, 0)}`);
if (!delivered) process.exitCode = 1;
