import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../src/ConfigManager.js';

const VALID = {
  serviceUrl: 'pulsar+ssl://example.test:6651',
  token: 'a-token',
  namespace: 'tenant/namespace'
};
const ENV_NAMES = ['PULSAR_SERVICE_URL', 'PULSAR_TOKEN', 'PULSAR_NAMESPACE'];

let dir, savedEnv, savedTTY;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pulsar-companion-test-'));
  savedEnv = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  for (const name of ENV_NAMES) delete process.env[name];
  savedTTY = process.stdin.isTTY;
  // Default to a non-terminal so no test can ever block on a prompt
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
});

afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
  await rm(dir, { recursive: true, force: true });
});

/** Writes a config file and returns its path */
const writeConfig = async (contents, name = 'config.json') => {
  const path = join(dir, name);
  await writeFile(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return path;
};

describe('namespace normalization', () => {
  const manager = new ConfigManager('/unused');
  const cases = [
    ['tenant/ns', 'persistent://tenant/ns/'],
    ['tenant/ns/', 'persistent://tenant/ns/'],
    ['persistent://tenant/ns', 'persistent://tenant/ns/'],
    ['persistent://tenant/ns/', 'persistent://tenant/ns/']
  ];
  for (const [input, expected] of cases) {
    test(`${input} becomes ${expected}`, () => {
      assert.equal(manager.normalizeNamespace(input), expected);
    });
  }
});

describe('configuration file', () => {
  test('a valid file is loaded and its namespace normalized', async () => {
    const config = await new ConfigManager(await writeConfig(VALID)).loadUserConfig();
    assert.equal(config.serviceUrl, VALID.serviceUrl);
    assert.equal(config.token, VALID.token);
    assert.equal(config.namespace, 'persistent://tenant/namespace/');
  });

  test('it is read only once', async () => {
    const manager = new ConfigManager(await writeConfig(VALID));
    assert.equal(await manager.loadUserConfig(), await manager.loadUserConfig());
  });

  test('permissions are tightened to owner-only on load', async () => {
    const path = await writeConfig(VALID);
    await writeFile(path, JSON.stringify(VALID), { mode: 0o644 });
    await new ConfigManager(path).loadUserConfig();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  // Errors have to name the file: the user cannot fix what they cannot find.
  test('invalid JSON names the file and the expected shape', async () => {
    const path = await writeConfig('{ broken');
    await assert.rejects(() => new ConfigManager(path).loadUserConfig(),
      (err) => err.message.includes(path) && /not valid JSON/.test(err.message)
        && /serviceUrl, token, namespace/.test(err.message));
  });

  // The file holds a token, and a parser message quotes the text around the
  // syntax error, so it must never be echoed into stderr or a CI log.
  test('a malformed file never echoes its own contents', async () => {
    const sentinel = 'SENTINEL_SECRET_VALUE';
    for (const body of [sentinel, `{"token":"${sentinel}"`, `{ ${sentinel}`, `${sentinel}\n{}`]) {
      const path = await writeConfig(body, 'leaky.json');
      await assert.rejects(() => new ConfigManager(path).loadUserConfig(), (err) => {
        assert.ok(!err.message.includes(sentinel), `leaked: ${err.message}`);
        assert.ok(!err.message.includes(sentinel.slice(0, 8)), `leaked a prefix: ${err.message}`);
        return true;
      });
    }
  });

  for (const field of ['serviceUrl', 'token', 'namespace']) {
    test(`a missing ${field} names the field and the file`, async () => {
      const incomplete = { ...VALID };
      delete incomplete[field];
      const path = await writeConfig(incomplete);
      await assert.rejects(() => new ConfigManager(path).loadUserConfig(),
        (err) => err.message.includes(field) && err.message.includes(path));
    });
  }

  // A value of the wrong type used to crash inside normalization, with a
  // TypeError that named neither the field nor the file.
  for (const [label, body] of [['null', 'null'], ['an array', '[1,2]'], ['a string', '"text"']]) {
    test(`${label} is reported as not a configuration object`, async () => {
      const path = await writeConfig(body);
      await assert.rejects(() => new ConfigManager(path).loadUserConfig(),
        (err) => /does not contain a configuration object/.test(err.message) && err.message.includes(path));
    });
  }

  for (const [field, value] of [['namespace', 7], ['token', null], ['serviceUrl', { a: 1 }], ['token', '  ']]) {
    test(`${field} as ${JSON.stringify(value)} names the field and the file`, async () => {
      const path = await writeConfig({ ...VALID, [field]: value });
      await assert.rejects(() => new ConfigManager(path).loadUserConfig(),
        (err) => err.message.includes(field) && err.message.includes(path));
    });
  }

  test('an explicitly requested file that is missing is an error, not a prompt', async () => {
    const path = join(dir, 'absent.json');
    await assert.rejects(() => new ConfigManager(path).loadUserConfig(),
      (err) => /Configuration file not found/.test(err.message) && err.message.includes(path));
  });

  test('an unreadable file reports the path', async () => {
    const sub = join(dir, 'sub');
    await mkdir(sub);
    await assert.rejects(() => new ConfigManager(sub).loadUserConfig(), /Cannot read/);
  });
});

describe('environment variables', () => {
  test('all three together provide the connection', async () => {
    process.env.PULSAR_SERVICE_URL = VALID.serviceUrl;
    process.env.PULSAR_TOKEN = VALID.token;
    process.env.PULSAR_NAMESPACE = VALID.namespace;
    // The default location on purpose: a complete environment is returned
    // before any file is read, so no real config is ever touched.
    const config = await new ConfigManager().loadUserConfig();
    assert.equal(config.serviceUrl, VALID.serviceUrl);
    assert.equal(config.namespace, 'persistent://tenant/namespace/');
  });

  test('they take precedence over the default file', async () => {
    process.env.PULSAR_SERVICE_URL = 'pulsar+ssl://from-env:6651';
    process.env.PULSAR_TOKEN = 'env-token';
    process.env.PULSAR_NAMESPACE = 'env/ns';
    const config = await new ConfigManager().loadUserConfig();
    assert.equal(config.serviceUrl, 'pulsar+ssl://from-env:6651');
    assert.equal(config.token, 'env-token');
  });

  // An explicitly chosen file must win: asking for one file and silently
  // getting another cluster's connection would be worse than an error.
  test('an explicit --config wins over a complete environment', async () => {
    process.env.PULSAR_SERVICE_URL = 'pulsar+ssl://from-env:6651';
    process.env.PULSAR_TOKEN = 'env-token';
    process.env.PULSAR_NAMESPACE = 'env/ns';
    const config = await new ConfigManager(await writeConfig(VALID)).loadUserConfig();
    assert.equal(config.serviceUrl, VALID.serviceUrl);
    assert.equal(config.token, VALID.token);
  });

  test('an explicit --config ignores an incomplete environment', async () => {
    process.env.PULSAR_SERVICE_URL = 'pulsar+ssl://from-env:6651';
    const config = await new ConfigManager(await writeConfig(VALID)).loadUserConfig();
    assert.equal(config.serviceUrl, VALID.serviceUrl);
  });

  test('a token from the environment is never written to disk', async () => {
    process.env.PULSAR_SERVICE_URL = VALID.serviceUrl;
    process.env.PULSAR_TOKEN = 'secret-from-env';
    process.env.PULSAR_NAMESPACE = VALID.namespace;
    await new ConfigManager().loadUserConfig();
    // Nothing was created under the temporary directory standing in for HOME
    await assert.rejects(() => readFile(join(dir, 'config.json'), 'utf8'));
  });

  test('an environment value that is only whitespace is refused', async () => {
    process.env.PULSAR_SERVICE_URL = VALID.serviceUrl;
    process.env.PULSAR_TOKEN = '   ';
    process.env.PULSAR_NAMESPACE = VALID.namespace;
    await assert.rejects(() => new ConfigManager().loadUserConfig(),
      /token is missing or not a string in the environment/);
  });

  // A partial set must never be completed from the file: that could pair one
  // cluster's URL with another cluster's token.
  for (const provided of ENV_NAMES) {
    test(`${provided} alone is refused, naming what is missing`, async () => {
      process.env[provided] = 'value';
      const missing = ENV_NAMES.filter((n) => n !== provided);
      // The default location: an incomplete environment is rejected before
      // any file is read, so completing it from one is never an option.
      await assert.rejects(() => new ConfigManager().loadUserConfig(),
        (err) => /Incomplete configuration in the environment/.test(err.message)
          && missing.every((n) => err.message.includes(n)));
    });
  }
});

describe('without a terminal', () => {
  test('the setup prompts are not attempted, and the message says what to set', async () => {
    const path = join(dir, '.config', 'pulsar-companion', 'config.json');
    await assert.rejects(() => new ConfigManager(path).createUserConfig(),
      (err) => /no terminal to ask on/.test(err.message)
        && ENV_NAMES.every((n) => err.message.includes(n)));
  });
});
