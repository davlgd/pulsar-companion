import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Pulsar from 'pulsar-client';
import { PulsarConsumer } from '../src/PulsarConsumer.js';
import { CONFIG } from '../src/config.js';

const BASE = Date.parse('2026-09-13T10:00:00Z');

/** Builds a message double */
const message = (body, id, offsetMs) => ({
  getData: () => Buffer.from(body),
  getMessageId: () => id,
  getPartitionKey: () => 'k',
  getPublishTimestamp: () => BASE + offsetMs
});

const readerArgs = (sinceValue) => ({
  hasParam: (param) => param === 'since',
  getSinceValue: () => sinceValue,
  getSubscriptionName: () => 'sub'
});

/**
 * Drives a reader through its startup, letting a scenario deliver messages at
 * chosen moments, and records what reached the output.
 * @param {object} moments - Callbacks receiving the listener
 * @param {object} [options] - Set breakPrint to make printing fail
 * @returns {Promise<object>} The delivered bodies and the consumer
 */
async function runReader(moments, { breakPrint = false, sinceValue = BASE - 86400000 } = {}) {
  const delivered = [];
  let listener;

  const client = {
    createReader: async (config) => {
      listener = config.listener;
      const reader = {
        seekTimestamp: async () => {
          // The native seek repositions the reader before this promise
          // resolves, so the listener can already be firing with history.
          moments.duringSeek?.(listener);
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
        close: async () => { reader.closed = true; },
        closed: false
      };
      moments.onCreate?.(listener);
      return reader;
    }
  };

  const consumer = new PulsarConsumer(client, CONFIG, readerArgs(sinceValue));
  consumer.printMessage = (msg) => {
    if (breakPrint) throw new Error('print-failed');
    delivered.push(msg.getData().toString());
  };

  await consumer.create('persistent://tenant/ns/topic', null);
  moments.afterSeek?.(listener);
  return { delivered, consumer };
}

describe('reader delivery', () => {
  test('history delivered before the seek resolves is kept', async () => {
    // Dropping these would lose them for good: the seek does not replay twice.
    const { delivered } = await runReader({
      duringSeek: (listener) => {
        listener(message('OLD-A', 'id-A', 1000));
        listener(message('OLD-B', 'id-B', 2000));
      }
    });
    assert.deepEqual(delivered, ['OLD-A', 'OLD-B']);
  });

  test('a redelivery arriving before the seek resolves is suppressed', async () => {
    // The window message is replayed by the seek while we are still awaiting it.
    const { delivered } = await runReader({
      onCreate: (listener) => listener(message('LIVE-X', 'id-X', 5000)),
      duringSeek: (listener) => {
        listener(message('OLD-A', 'id-A', 1000));
        listener(message('LIVE-X', 'id-X', 5000));
      }
    });
    assert.deepEqual(delivered, ['LIVE-X', 'OLD-A']);
  });

  test('a redelivery arriving after the seek resolves is suppressed', async () => {
    const { delivered } = await runReader({
      duringSeek: (listener) => {
        listener(message('OLD-A', 'id-A', 1000));
        listener(message('OLD-B', 'id-B', 2000));
      },
      afterSeek: (listener) => {
        listener(message('OLD-A', 'id-A', 1000));
        listener(message('OLD-B', 'id-B', 2000));
        listener(message('NEW-C', 'id-C', 9000));
      }
    });
    assert.deepEqual(delivered, ['OLD-A', 'OLD-B', 'NEW-C']);
  });

  test('redeliveries on both sides of the seek are suppressed', async () => {
    const { delivered } = await runReader({
      onCreate: (listener) => listener(message('LIVE-X', 'id-X', 5000)),
      duringSeek: (listener) => {
        listener(message('OLD-A', 'id-A', 1000));
        listener(message('LIVE-X', 'id-X', 5000));
      },
      afterSeek: (listener) => {
        listener(message('OLD-A', 'id-A', 1000));
        listener(message('NEW-C', 'id-C', 9000));
      }
    });
    assert.deepEqual(delivered, ['LIVE-X', 'OLD-A', 'NEW-C']);
  });

  // Known limitation: a message from the seek window can be printed before
  // older history, so output is not strictly chronological during startup.
  test('output during the seek window is not strictly chronological', async () => {
    const { delivered } = await runReader({
      onCreate: (listener) => listener(message('LIVE-X', 'id-X', 5000)),
      duringSeek: (listener) => listener(message('OLD-A', 'id-A', 1000))
    });
    assert.deepEqual(delivered, ['LIVE-X', 'OLD-A'], 'the newer message is printed first');
  });

  test('messages are not dropped while the reader is being created', async () => {
    const { delivered } = await runReader({
      onCreate: (listener) => listener(message('EARLY', 'id-E', 100))
    }, { sinceValue: 'earliest' });
    assert.deepEqual(delivered, ['EARLY']);
  });
});

describe('reader creation window', () => {
  // The native message ids expose no enumerable properties, so a structural
  // comparison of two different ids passes. The invariants below therefore
  // compare their printed form, and this pins that it actually discriminates.
  test('the comparison used below distinguishes earliest from latest', () => {
    assert.notEqual(String(Pulsar.MessageId.earliest()), String(Pulsar.MessageId.latest()));
  });

  // A delivery reaching the native listener before createReader() settles is
  // discarded rather than queued, so the reader must not be created at a
  // position that already has messages waiting. Starting at the end keeps the
  // backlog away from that path; the reposition then replays it.
  for (const [label, sinceValue, expectedSeek] of [
    ['earliest', 'earliest', 0],
    ['a past timestamp', BASE - 86400000, BASE - 86400000]
  ]) {
    test(`${label} starts at the end and repositions to ${expectedSeek}`, async () => {
      let startedAt;
      const seeks = [];
      const client = {
        createReader: async (config) => {
          startedAt = config.startMessageId;
          return { seekTimestamp: async (ts) => { seeks.push(ts); }, close: async () => {} };
        }
      };
      const consumer = new PulsarConsumer(client, CONFIG, readerArgs(sinceValue));
      consumer.printMessage = () => {};
      await consumer.create('persistent://tenant/ns/topic', null);

      assert.equal(String(startedAt), String(Pulsar.MessageId.latest()), 'created at the end of the topic');
      assert.deepEqual(seeks, [expectedSeek], 'repositioned once, after creation');
    });
  }

  // These want no history, so there is nothing to reposition to.
  for (const [label, sinceValue] of [
    ['latest', 'latest'],
    ['a future timestamp', Date.now() + 86400000]
  ]) {
    test(`${label} starts at the end and does not reposition`, async () => {
      const seeks = [];
      let startedAt;
      const client = {
        createReader: async (config) => {
          startedAt = config.startMessageId;
          return { seekTimestamp: async (ts) => { seeks.push(ts); }, close: async () => {} };
        }
      };
      const consumer = new PulsarConsumer(client, CONFIG, readerArgs(sinceValue));
      consumer.printMessage = () => {};
      const warn = console.warn;
      console.warn = () => {};
      try { await consumer.create('persistent://tenant/ns/topic', null); } finally { console.warn = warn; }

      assert.equal(String(startedAt), String(Pulsar.MessageId.latest()));
      assert.deepEqual(seeks, [], 'no reposition, so the end stays the boundary');
    });
  }

  // The mitigation must not cost what it is meant to protect: a callback
  // handed over while the reposition is still running has to be printed.
  test('a callback delivered during the earliest reposition is printed', async () => {
    const printed = [];
    const client = {
      createReader: async (config) => ({
        seekTimestamp: async () => {
          config.listener(message('DURING', 'id-d', 500));
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
        close: async () => {}
      })
    };
    const consumer = new PulsarConsumer(client, CONFIG, readerArgs('earliest'));
    consumer.printMessage = (msg) => printed.push(msg.getData().toString());
    await consumer.create('persistent://tenant/ns/topic', null);
    assert.deepEqual(printed, ['DURING']);
  });

  // The reposition replays what it repositions over, so the same message can
  // arrive twice on the earliest path exactly as it can on the timestamp one.
  test('a redelivery around the earliest reposition is printed once', async () => {
    const printed = [];
    let listener;
    const client = {
      createReader: async (config) => {
        listener = config.listener;
        return {
          seekTimestamp: async () => {
            listener(message('REPLAYED', 'id-r', 400));
            await new Promise((resolve) => setTimeout(resolve, 10));
          },
          close: async () => {}
        };
      }
    };
    const consumer = new PulsarConsumer(client, CONFIG, readerArgs('earliest'));
    consumer.printMessage = (msg) => printed.push(msg.getData().toString());
    await consumer.create('persistent://tenant/ns/topic', null);

    // The replay hands the same id over again once the reposition is done
    listener(message('REPLAYED', 'id-r', 400));
    listener(message('AFTER', 'id-a', 900));

    assert.deepEqual(printed, ['REPLAYED', 'AFTER'], 'printed once, then the next one');
  });

  test('a failing earliest reposition closes the reader and propagates', async () => {
    let closed = false;
    const client = {
      createReader: async () => ({
        seekTimestamp: async () => { throw new Error('seek refused'); },
        close: async () => { closed = true; }
      })
    };
    const consumer = new PulsarConsumer(client, CONFIG, readerArgs('earliest'));
    consumer.printMessage = () => {};
    await assert.rejects(() => consumer.create('persistent://tenant/ns/topic', null), /seek refused/);
    assert.ok(closed, 'the reader was closed rather than leaked');
  });
});

describe('reader failures', () => {
  // A throwing listener used to leave the run hanging with no status at all.
  test('a printing failure is reported instead of hanging', async () => {
    const { consumer } = await runReader({
      duringSeek: (listener) => listener(message('X', 'id-X', 1000))
    }, { breakPrint: true });

    await assert.rejects(
      () => Promise.race([
        consumer.receiveMessages(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 500))
      ]),
      /print-failed/
    );
  });

  test('a failing seek closes the reader instead of leaking it', async () => {
    let closed = false;
    const client = {
      createReader: async () => ({
        seekTimestamp: async () => { throw new Error('seek refused'); },
        close: async () => { closed = true; }
      })
    };
    const consumer = new PulsarConsumer(client, CONFIG, readerArgs(BASE - 86400000));
    await assert.rejects(() => consumer.create('persistent://tenant/ns/topic', null), /seek refused/);
    assert.ok(closed, 'the reader was closed');
  });

  test('close() releases a waiting receiveMessages()', async () => {
    const { consumer } = await runReader({});
    const waiting = consumer.receiveMessages();
    await consumer.close();
    await waiting;
  });

  test('a future timestamp falls back to latest with a warning', async () => {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      await runReader({}, { sinceValue: Date.now() + 86400000 });
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /--since is in the future/);
  });
});

describe('subscriber delivery', () => {
  /**
   * Drives the consumer (non-reader) path over a queue of messages
   * @param {Array} queue - Messages to hand out, then a close
   * @returns {Promise<object>} What was printed and acknowledged
   */
  async function runSubscriber(queue, { failOn = null, stayPending = false } = {}) {
    const printed = [];
    const acknowledged = [];
    const closes = [];
    let consumerRef;
    let settlePending;
    let announceWaiting;
    // Resolves once the loop is parked inside receive() with nothing to return
    const waiting = new Promise((resolve) => { announceWaiting = resolve; });

    const client = {
      subscribe: async (config) => {
        consumerRef = {
          config,
          receive: async () => {
            const next = queue.shift();
            if (!next) {
              announceWaiting();
              // Stay pending so a test can close while the loop waits, which
              // is the situation the real close() has to handle.
              if (stayPending) return new Promise((_, reject) => { settlePending = reject; });
              // Otherwise end the loop through the real close path
              await consumer.close();
              throw new Error('AlreadyClosed');
            }
            if (next === 'timeout') {
              const err = new Error('timed out');
              err.name = 'TimeoutError';
              throw err;
            }
            return next;
          },
          acknowledge: async (msg) => {
            if (failOn === msg.getData().toString()) throw new Error('ack refused');
            acknowledged.push(msg.getData().toString());
          },
          // Only records: setting `closed` is the implementation's own job
          close: async () => { closes.push('consumer'); }
        };
        return consumerRef;
      }
    };

    const argParser = {
      hasParam: () => false,
      getSinceValue: () => null,
      getSubscriptionName: () => 'my_sub'
    };
    const consumer = new PulsarConsumer(client, CONFIG, argParser);
    consumer.printMessage = (msg) => printed.push(msg.getData().toString());
    await consumer.create('persistent://tenant/ns/topic', 'Exclusive');
    return {
      consumer, printed, acknowledged, closes, waiting,
      config: () => consumerRef.config,
      failPending: (err) => settlePending?.(err)
    };
  }

  test('each message is printed and acknowledged', async () => {
    const run = await runSubscriber([message('A', 'id-A', 1), message('B', 'id-B', 2)]);
    await run.consumer.receiveMessages();
    assert.deepEqual(run.printed, ['A', 'B']);
    assert.deepEqual(run.acknowledged, ['A', 'B']);
  });

  test('a receive timeout is retried rather than fatal', async () => {
    const run = await runSubscriber(['timeout', message('A', 'id-A', 1), 'timeout', message('B', 'id-B', 2)]);
    await run.consumer.receiveMessages();
    assert.deepEqual(run.printed, ['A', 'B']);
  });

  test('the subscription is created with the requested name and type', async () => {
    const run = await runSubscriber([]);
    assert.equal(run.config().subscription, 'my_sub');
    assert.equal(run.config().subscriptionType, 'Exclusive');
  });

  // An acknowledgement failure is a real problem: it must not be swallowed.
  test('a failing acknowledgement is reported', async () => {
    const run = await runSubscriber([message('A', 'id-A', 1)], { failOn: 'A' });
    await assert.rejects(() => run.consumer.receiveMessages(), /ack refused/);
  });

  // The loop is parked in receive() when the shutdown arrives, which is the
  // only situation the real close() exists for. The double no longer ends the
  // loop itself, so a broken close() cannot pass this.
  test('close() ends a loop that is waiting on receive()', async () => {
    const run = await runSubscriber([message('A', 'id-A', 1)], { stayPending: true });
    const loop = run.consumer.receiveMessages();

    await run.waiting;
    assert.equal(run.consumer.closed, false, 'still open while waiting');

    await run.consumer.close();
    assert.equal(run.consumer.closed, true, 'close() marked it closed');
    assert.deepEqual(run.closes, ['consumer'], 'it closed the underlying consumer once');

    // The broker rejects the receive that was in flight; the loop must treat
    // that as the shutdown it asked for and return rather than throw.
    run.failPending(new Error('AlreadyClosed'));
    await loop;

    assert.deepEqual(run.printed, ['A']);
  });

  test('a second close() does not close the consumer twice', async () => {
    const run = await runSubscriber([message('A', 'id-A', 1)], { stayPending: true });
    const loop = run.consumer.receiveMessages();
    await run.waiting;

    await run.consumer.close();
    await run.consumer.close();
    assert.deepEqual(run.closes, ['consumer']);

    run.failPending(new Error('AlreadyClosed'));
    await loop;
  });
});
