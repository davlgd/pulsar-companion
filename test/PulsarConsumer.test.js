import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
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
  async function runSubscriber(queue, { failOn = null } = {}) {
    const printed = [];
    const acknowledged = [];
    let consumerRef;

    const client = {
      subscribe: async (config) => {
        consumerRef = {
          config,
          receive: async () => {
            const next = queue.shift();
            if (!next) {
              // Nothing left: behave like a consumer closed under us
              await consumerRef.close();
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
          close: async () => { consumer.closed = true; }
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
    return { consumer, printed, acknowledged, config: () => consumerRef.config };
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

  test('close() stops the loop without an error', async () => {
    const run = await runSubscriber([message('A', 'id-A', 1)]);
    await run.consumer.receiveMessages();
    assert.deepEqual(run.printed, ['A']);
  });
});
