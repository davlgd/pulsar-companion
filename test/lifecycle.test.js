import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Pulsar from 'pulsar-client';
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

describe('client options', () => {
  /**
   * Connects with the client construction intercepted, so the options that
   * would reach pulsar-client can be inspected without a broker
   * @param {object} [options] - ioThreads to pass to connect()
   * @returns {Promise<object>} The captured client options
   */
  // A distinctive timeout, so asserting it proves the value travelled from
  // the configuration rather than matching the global default by accident.
  const TIMEOUT = 4321;

  async function capturedOptions({ ioThreads } = {}) {
    const parser = new ArgumentParser([]);
    const config = { ...CONFIG, pulsar: { ...CONFIG.pulsar, timeouts: { ...CONFIG.pulsar.timeouts, operation: TIMEOUT } } };
    const manager = new PulsarManager(config, parser);
    manager.configManager = {
      loadUserConfig: async () => ({
        serviceUrl: 'pulsar+ssl://broker.example:6651',
        token: 'a-token',
        namespace: 'persistent://tenant/ns/'
      })
    };

    let captured;
    const fakeClient = { close: async () => {} };
    manager.createClient = (clientConfig) => {
      captured = clientConfig;
      return fakeClient;
    };
    await manager.connect(ioThreads);
    return { options: captured, manager, fakeClient };
  }

  /** Convenience for the assertions that only look at the options */
  const optionsOf = async (args) => (await capturedOptions(args)).options;

  // The C++ client defaults this to false, which accepts a certificate issued
  // for any host and would send the token to whoever answers. Without this
  // assertion, dropping the option would leave the suite green.
  test('the broker hostname is verified', async () => {
    const options = await optionsOf();
    assert.equal(options.tlsValidateHostname, true);
  });

  test('the service url comes from the configuration', async () => {
    const options = await optionsOf();
    assert.equal(options.serviceUrl, 'pulsar+ssl://broker.example:6651');
  });

  // This checks the type the token is wrapped in, not its value: the object
  // is opaque, so the value itself is not observable here.
  test('the token is wrapped in an AuthenticationToken rather than passed bare', async () => {
    const options = await optionsOf();
    assert.ok(options.authentication instanceof Pulsar.AuthenticationToken);
    assert.equal(typeof options.authentication, 'object');
  });

  // The client that connect() built has to be the one it keeps, or the
  // options asserted above would not be the ones in use.
  test('the client it built is the one it keeps', async () => {
    const { manager, fakeClient } = await capturedOptions();
    assert.equal(manager.client, fakeClient);
  });

  test('the operation timeout comes from the configuration', async () => {
    const options = await optionsOf();
    assert.equal(options.operationTimeoutSeconds, TIMEOUT);
    assert.notEqual(TIMEOUT, CONFIG.pulsar.timeouts.operation, 'the value is distinctive');
  });

  test('ioThreads is what connect() was given, or the default', async () => {
    assert.equal((await optionsOf({ ioThreads: 4 })).ioThreads, 4);
    assert.equal((await optionsOf()).ioThreads, CONFIG.defaultThreads);
  });

  // These two specifically, not every option: they are the pair that would
  // silently undo the hostname check if either were flipped.
  test('tlsAllowInsecureConnection is not enabled and the hostname check is not disabled', async () => {
    const options = await optionsOf();
    assert.notEqual(options.tlsAllowInsecureConnection, true);
    assert.notEqual(options.tlsValidateHostname, false);
  });
});
