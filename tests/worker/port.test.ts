import { describe, it, expect } from 'vitest';
import { MessageChannel } from 'worker_threads';
import { NodeWorkerPort } from '../../src/worker/port';

describe('NodeWorkerPort', () => {
  it('round-trips messages over a MessageChannel', async () => {
    const { port1, port2 } = new MessageChannel();
    const a = new NodeWorkerPort(port1);

    const received: unknown[] = [];
    const unsub = a.onMessage((d) => received.push(d));

    // worker -> main (port1 -> port2)
    a.postMessage({ hello: 1 });
    // main -> worker (port2 -> port1): need port2 on the other side
    port2.on('message', (d) => port2.postMessage({ echo: d }));
    a.postMessage({ hello: 2 });

    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBeGreaterThanOrEqual(2); // at least the echoes back
    unsub();
    port1.close();
    port2.close();
  });

  it('unsubscribe stops delivery', async () => {
    const { port1, port2 } = new MessageChannel();
    const a = new NodeWorkerPort(port1);
    let count = 0;
    const unsub = a.onMessage(() => count++);
    port2.postMessage('x');
    await new Promise((r) => setTimeout(r, 30));
    const before = count;
    unsub();
    port2.postMessage('y');
    await new Promise((r) => setTimeout(r, 30));
    expect(count).toBe(before);
    port1.close();
    port2.close();
  });
});
