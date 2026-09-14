import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, stat, readFile, chmod as chmodFs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager, hardenIfRegularFile } from '../src/ConfigManager.js';

const VALID = {
  serviceUrl: 'pulsar+ssl://example.test:6651',
  token: 'a-token',
  namespace: 'tenant/namespace'
};
const ENV_NAMES = ['PULSAR_SERVICE_URL', 'PULSAR_TOKEN', 'PULSAR_NAMESPACE'];

// HOME and USERPROFILE are redirected too: the tests that exercise the
// default location must resolve it inside the temporary directory, never in
// the developer's real home, whatever the loading order turns out to be.
const HOME_NAMES = ['HOME', 'USERPROFILE'];

let dir, savedEnv, savedTTY;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pulsar-companion-test-'));
  savedEnv = Object.fromEntries([...ENV_NAMES, ...HOME_NAMES].map((n) => [n, process.env[n]]));
  for (const name of ENV_NAMES) delete process.env[name];
  for (const name of HOME_NAMES) process.env[name] = dir;
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

  // Some inputs carry no parser offset at all, and the diagnostic must say so
  // rather than quietly omitting the location for exactly those files.
  for (const [label, body, expected] of [
    ['an empty file', '', /\(the file is empty\)/],
    ['whitespace only', '   \n  ', /\(the file is empty\)/],
    ['a bare token', 'not-json-at-all', /\(the parser reported no location\)/],
    // The engine quotes the file, so its own text must not be read as an
    // offset: this content would otherwise be reported as line 1.
    ['content that looks like an offset', 'position 123', /\(the parser reported no location\)/],
    ['a broken object', '{\n  "a": 1,\n  broken\n}', /\(line 3\)/]
  ]) {
    test(`${label} reports where it failed`, async () => {
      const path = await writeConfig(body, 'located.json');
      await assert.rejects(() => new ConfigManager(path).loadUserConfig(),
        (err) => expected.test(err.message) && err.message.includes('is not valid JSON'));
    });
  }

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

  // The file holds a token, so a file the parser or the validation rejects
  // must not keep loose permissions while the user edits and retries.
  for (const [label, body] of [['malformed', '{ broken'], ['invalid', '{"serviceUrl":"pulsar+ssl://h:6651"}']]) {
    test(`a ${label} file still has its permissions tightened`, async () => {
      const path = join(dir, 'loose.json');
      await writeFile(path, body, { mode: 0o644 });
      await assert.rejects(() => new ConfigManager(path).loadUserConfig());
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    });
  }

  // Only regular files are hardened: a device or a FIFO handed to --config
  // must be read without its mode being changed. Driven with a handle double,
  // so there is no special file to create and nothing that can outlive the test.
  test('a handle that is not a regular file is not chmod-ed', async () => {
    let chmodded = false;
    const handle = {
      stat: async () => ({ isFile: () => false }),
      chmod: async () => { chmodded = true; }
    };
    assert.equal(await hardenIfRegularFile(handle), false);
    assert.equal(chmodded, false, 'a device or FIFO must keep its mode');
  });

  test('a handle that is a regular file is chmod-ed to owner-only', async () => {
    const modes = [];
    const handle = {
      stat: async () => ({ isFile: () => true }),
      chmod: async (mode) => { modes.push(mode); }
    };
    assert.equal(await hardenIfRegularFile(handle), true);
    assert.deepEqual(modes, [0o600]);
  });

  test('a chmod that fails does not stop the load', async () => {
    const handle = {
      stat: async () => ({ isFile: () => true }),
      chmod: async () => { throw new Error('read-only filesystem'); }
    };
    assert.equal(await hardenIfRegularFile(handle), true);
  });

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
    // A real file at the redirected default location, so precedence is
    // actually exercised rather than passing because nothing is there.
    await mkdir(join(dir, '.config', 'pulsar-companion'), { recursive: true });
    await writeFile(join(dir, '.config', 'pulsar-companion', 'config.json'),
      JSON.stringify({ ...VALID, serviceUrl: 'pulsar+ssl://from-file:6651' }));
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
    // Nothing was written at the default location, which HOME now points into
    await assert.rejects(() => readFile(join(dir, '.config', 'pulsar-companion', 'config.json'), 'utf8'));
  });

  // An explicitly empty variable is set, so it must be refused rather than
  // letting a file for another cluster take over in an unattended run.
  test('all three set to empty strings are refused, not ignored', async () => {
    await mkdir(join(dir, '.config', 'pulsar-companion'), { recursive: true });
    await writeFile(join(dir, '.config', 'pulsar-companion', 'config.json'),
      JSON.stringify({ ...VALID, serviceUrl: 'pulsar+ssl://persisted:6651' }));
    for (const name of ENV_NAMES) process.env[name] = '';
    await assert.rejects(() => new ConfigManager().loadUserConfig(),
      /serviceUrl is missing or not a string in the environment/);
  });

  test('one set to an empty string still counts as provided', async () => {
    process.env.PULSAR_SERVICE_URL = '';
    await assert.rejects(() => new ConfigManager().loadUserConfig(),
      (err) => /Incomplete configuration in the environment/.test(err.message)
        && err.message.includes('PULSAR_TOKEN') && err.message.includes('PULSAR_NAMESPACE'));
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

describe('the setup prompts', () => {
  // A config the loader would refuse must never reach the disk, or every
  // later run fails on a file we wrote ourselves.
  test('an answer set the loader would refuse is not written', async () => {
    const path = join(dir, 'written.json');
    const manager = new ConfigManager(path);

    await assert.rejects(
      () => manager.persistConfig({ namespace: 'tenant/ns', serviceUrl: 'pulsar+ssl://h:6651', token: '   ' }),
      /token is missing or not a string in the answers given/
    );
    await assert.rejects(() => readFile(path, 'utf8'), 'nothing must be persisted');
  });

  // This path runs only when no file was found, so a file that appeared in
  // the meantime belongs to someone else: it must be kept, not emptied, and
  // the token must not land in a file whose permissions we do not control.
  test('a path that appeared meanwhile is refused, content and mode intact', async () => {
    const path = join(dir, 'raced.json');
    await writeFile(path, 'a configuration someone else just wrote', { mode: 0o600 });
    await chmodFs(path, 0o644);

    const manager = new ConfigManager(path);
    await assert.rejects(() => manager.persistConfig({ ...VALID }),
      (err) => /appeared while the questions were being answered, and was left untouched/.test(err.message)
        // The advice has to be something that actually works: --config on a
        // missing path is refused before any question is asked.
        && /--config <path> to load another existing configuration/.test(err.message));

    assert.equal(await readFile(path, 'utf8'), 'a configuration someone else just wrote',
      'their content survived');
    assert.equal((await stat(path)).mode & 0o777, 0o644, 'their permissions survived');
  });

  // The create mode is masked by umask, which can only remove bits, so an
  // unusual umask yields a file the owner cannot even rewrite. The explicit
  // chmod normalises it to exactly 0600.
  test('an unusual umask still yields exactly owner read-write', async () => {
    const previous = process.umask(0o200);
    try {
      const path = join(dir, 'umasked.json');
      await new ConfigManager(path).persistConfig({ ...VALID });
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    } finally {
      process.umask(previous);
    }
  });

  test('a valid answer set is written owner-only and normalized', async () => {
    const path = join(dir, 'written.json');
    const manager = new ConfigManager(path);

    const config = await manager.persistConfig({ ...VALID });
    assert.equal(config.namespace, 'persistent://tenant/namespace/');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), VALID, 'the raw answers are stored');
  });
});

describe('without a terminal', () => {
  test('the setup prompts are not attempted, and the message says what to set', async () => {
    const path = join(dir, '.config', 'pulsar-companion', 'config.json');
    await assert.rejects(() => new ConfigManager(path).createUserConfig(),
      (err) => /no terminal to ask on/.test(err.message)
        && ENV_NAMES.every((n) => err.message.includes(n)));
  });
});
