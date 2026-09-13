import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PulsarProducer } from '../src/PulsarProducer.js';
import { PulsarManager } from '../src/PulsarManager.js';
import { ArgumentParser } from '../src/ArgumentParser.js';
import { CONFIG } from '../src/config.js';

/**
 * A client double capturing what the producer is created and called with
 * @returns {object} The client double and its recorded calls
 */
function clientDouble() {
  const recorded = { config: null, sent: [], closed: false };
  const client = {
    createProducer: async (config) => {
      recorded.config = config;
      return {
        send: async (message) => { recorded.sent.push(message); },
        close: async () => { recorded.closed = true; }
      };
    }
  };
  return { client, recorded };
}

/**
 * Runs the manager's producer path with the given CLI arguments.
 * The key fallback here must match index.js exactly, or these tests measure
 * the helper instead of the CLI.
 */
async function produce(args) {
  const { client, recorded } = clientDouble();
  const argParser = new ArgumentParser(args);
  await argParser.validateArgs();

  const manager = new PulsarManager(CONFIG, argParser);
  manager.client = client;
  manager.configManager = { loadUserConfig: async () => ({ namespace: 'persistent://tenant/ns/' }) };

  await manager.createProducer(argParser.getCompression());
  await manager.sendMessage(argParser.getValue('send'), argParser.getValue('key') ?? CONFIG.defaultKey);
  return recorded;
}

describe('producer wiring', () => {
  // The payload is data: trimming or re-encoding it corrupts the message.
  test('the message reaches send() byte for byte', async () => {
    const payload = '  first line\nsecond line\n';
    const recorded = await produce(['--send', payload, '--topic', 'myTopic']);
    assert.equal(recorded.sent.length, 1);
    assert.deepEqual(recorded.sent[0].data, Buffer.from(payload));
    assert.equal(recorded.sent[0].data.toString(), payload);
  });

  for (const payload of ['', ' ', '\n', 'héllo wörld 🎉', '{"json":"payload"}', 'a\tb']) {
    test(`the payload ${JSON.stringify(payload)} is preserved`, async () => {
      const recorded = await produce(['--send', payload, '--topic', 'myTopic']);
      assert.deepEqual(recorded.sent[0].data, Buffer.from(payload));
    });
  }

  test('the key reaches send() unaltered', async () => {
    const recorded = await produce(['--send', 'x', '--key', ' spaced key ', '--topic', 'myTopic']);
    assert.equal(recorded.sent[0].partitionKey, ' spaced key ');
  });

  test('a flag key and a positional key agree', async () => {
    const viaFlag = await produce(['--send', 'x', '--key', ' k ', '--topic', 't']);
    const viaPositional = await produce(['--send', 'x', 't', 'sub', ' k ']);
    assert.equal(viaFlag.sent[0].partitionKey, viaPositional.sent[0].partitionKey);
  });

  test('the default key is used when none is given', async () => {
    const recorded = await produce(['--send', 'x', '--topic', 'myTopic']);
    assert.equal(recorded.sent[0].partitionKey, CONFIG.defaultKey);
  });

  // An explicitly empty key is a key: only an absent one takes the default.
  test('an empty key is sent as empty, not replaced by the default', async () => {
    const recorded = await produce(['--send', 'x', '--key', '', '--topic', 'myTopic']);
    assert.equal(recorded.sent[0].partitionKey, '');
  });

  // pulsar-client matches these case-sensitively, so the exact string the
  // CLI hands it is what decides whether compression happens at all.
  const spellings = { zlib: 'Zlib', ZLIB: 'Zlib', lz4: 'LZ4', zstd: 'ZSTD', snappy: 'SNAPPY', none: 'None' };
  for (const [typed, expected] of Object.entries(spellings)) {
    test(`--compression ${typed} is passed to the client as ${expected}`, async () => {
      const recorded = await produce(['--send', 'x', '--topic', 't', '--compression', typed]);
      assert.equal(recorded.config.compressionType, expected);
    });
  }

  test('the topic is fully qualified with the namespace', async () => {
    const recorded = await produce(['--send', 'x', '--topic', 'myTopic']);
    assert.equal(recorded.config.topic, 'persistent://tenant/ns/myTopic');
  });

  test('a surrounding-whitespace topic is trimmed', async () => {
    const recorded = await produce(['--send', 'x', '--topic', ' myTopic ']);
    assert.equal(recorded.config.topic, 'persistent://tenant/ns/myTopic');
  });
});

describe('producer lifecycle', () => {
  test('sending before create() is refused', async () => {
    const producer = new PulsarProducer(null, CONFIG);
    await assert.rejects(() => producer.sendMessage('x', 'k'), /Producer not initialized/);
  });

  test('close() is safe when nothing was created', async () => {
    await new PulsarProducer(null, CONFIG).close();
  });

  test('close() closes the underlying producer', async () => {
    const { client, recorded } = clientDouble();
    const producer = new PulsarProducer(client, CONFIG);
    await producer.create('persistent://tenant/ns/t', 'None');
    await producer.close();
    assert.ok(recorded.closed);
  });
});
