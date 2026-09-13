import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PulsarManager } from '../src/PulsarManager.js';
import { ArgumentParser } from '../src/ArgumentParser.js';
import { CONFIG } from '../src/config.js';

/** A resource double recording its close() call, optionally failing */
const closer = (calls, name, { fails = false } = {}) => ({
  close: async () => {
    calls.push(name);
    if (fails) throw new Error(`${name} failed`);
  }
});

describe('cleanup', () => {
  // A failing producer or consumer must not keep the client - and its IO
  // threads - from being released.
  test('a failing producer and consumer still let the client close', async () => {
    const calls = [];
    const manager = new PulsarManager(CONFIG, new ArgumentParser([]));
    manager.producer = closer(calls, 'producer', { fails: true });
    manager.consumer = closer(calls, 'consumer', { fails: true });
    manager.client = closer(calls, 'client');

    await Promise.all([manager.cleanup(), manager.cleanup()]);
    assert.deepEqual(calls, ['producer', 'consumer', 'client']);
  });

  test('it never throws, whatever fails', async () => {
    const manager = new PulsarManager(CONFIG, new ArgumentParser([]));
    manager.producer = closer([], 'producer', { fails: true });
    manager.client = closer([], 'client', { fails: true });
    await manager.cleanup();
  });

  // A signal handler and the finally block both call cleanup(); each resource
  // must still be closed exactly once.
  test('concurrent callers share a single run', async () => {
    const calls = [];
    const manager = new PulsarManager(CONFIG, new ArgumentParser([]));
    manager.producer = closer(calls, 'producer');
    manager.client = closer(calls, 'client');

    await Promise.all([manager.cleanup(), manager.cleanup(), manager.cleanup()]);
    assert.deepEqual(calls, ['producer', 'client']);
  });

  test('a later call does not close anything again', async () => {
    const calls = [];
    const manager = new PulsarManager(CONFIG, new ArgumentParser([]));
    manager.client = closer(calls, 'client');

    await manager.cleanup();
    await manager.cleanup();
    assert.deepEqual(calls, ['client']);
  });

  test('nothing to close is not an error', async () => {
    await new PulsarManager(CONFIG, new ArgumentParser([])).cleanup();
  });
});

describe('topic naming', () => {
  test('the namespace prefixes the topic', async () => {
    const manager = new PulsarManager(CONFIG, new ArgumentParser(['--topic', 'myTopic']));
    manager.configManager = { loadUserConfig: async () => ({ namespace: 'persistent://tenant/ns/' }) };
    assert.equal(await manager.getTopicName(), 'persistent://tenant/ns/myTopic');
  });

  test('the default topic is used when none is given', async () => {
    const manager = new PulsarManager(CONFIG, new ArgumentParser([]));
    manager.configManager = { loadUserConfig: async () => ({ namespace: 'persistent://tenant/ns/' }) };
    assert.equal(await manager.getTopicName(), `persistent://tenant/ns/${CONFIG.defaultTopic}`);
  });
});
