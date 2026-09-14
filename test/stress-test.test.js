import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ArgumentParser } from '../src/ArgumentParser.js';
import { CONFIG } from '../src/config.js';
import { sendMessages, runStressTest } from '../src/stress.js';

const run = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STRESS = join(ROOT, 'stress-test.js');

/**
 * A manager double recording what the loop asks of it
 * @param {object} [failures] - Set send to fail on that message body
 * @returns {object} The double and its recorded calls
 */
function managerDouble({ failOn = null } = {}) {
  const calls = { threads: null, compression: null, sent: [], cleanups: 0 };
  return {
    calls,
    connect: async (threads) => { calls.threads = threads; },
    createProducer: async (compression) => { calls.compression = compression; },
    sendMessage: async (message, key) => {
      if (failOn === message) throw new Error('send refused');
      calls.sent.push({ message, key });
    },
    cleanup: async () => { calls.cleanups += 1; }
  };
}

/** Builds a validated parser in stress mode */
async function stressArgs(argv) {
  const parser = new ArgumentParser(argv, true);
  await parser.validateArgs();
  return parser;
}

describe('stress loop', () => {
  test('it sends exactly the requested count, with rotating keys', async () => {
    const manager = managerDouble();
    await sendMessages(await stressArgs(['--count', '12', '--delay', '0']), manager, { pause: async () => {} });
    assert.equal(manager.calls.sent.length, 12);
    assert.deepEqual(manager.calls.sent[0], { message: 'Test message #1', key: 'key-1' });
    assert.deepEqual(manager.calls.sent[4], { message: 'Test message #5', key: 'key-0' });
  });

  // The delay separates messages, so there is nothing to wait for after the last.
  test('it pauses between messages but not after the last one', async () => {
    const waits = [];
    const manager = managerDouble();
    await sendMessages(await stressArgs(['--count', '4', '--delay', '25']), manager,
      { pause: async (ms) => { waits.push(ms); } });
    assert.deepEqual(waits, [25, 25, 25], 'three pauses for four messages');
  });

  test('a zero delay pauses not at all', async () => {
    const waits = [];
    const manager = managerDouble();
    await sendMessages(await stressArgs(['--count', '3', '--delay', '0']), manager,
      { pause: async (ms) => { waits.push(ms); } });
    assert.deepEqual(waits, []);
    assert.equal(manager.calls.sent.length, 3);
  });

  test('a zero count sends nothing and still completes', async () => {
    const manager = managerDouble();
    await sendMessages(await stressArgs(['--count', '0']), manager, { pause: async () => {} });
    assert.deepEqual(manager.calls.sent, []);
    assert.equal(manager.calls.compression, CONFIG.compressionTypes.NONE);
  });

  test('--threads reaches connect(), so an accepted option is not ignored', async () => {
    const manager = managerDouble();
    await sendMessages(await stressArgs(['--count', '1', '--threads', '4']), manager, { pause: async () => {} });
    assert.equal(manager.calls.threads, 4);
  });

  test('--threads defaults when absent', async () => {
    const manager = managerDouble();
    await sendMessages(await stressArgs(['--count', '1']), manager, { pause: async () => {} });
    assert.equal(manager.calls.threads, CONFIG.defaultThreads);
  });

  // The canonical spelling is what decides whether compression happens at all.
  test('--compression reaches createProducer() canonically', async () => {
    const manager = managerDouble();
    await sendMessages(await stressArgs(['--count', '1', '--compression', 'zlib']), manager, { pause: async () => {} });
    assert.equal(manager.calls.compression, 'Zlib');
  });

  test('a failing send propagates instead of being swallowed', async () => {
    const manager = managerDouble({ failOn: 'Test message #2' });
    const args = await stressArgs(['--count', '5', '--delay', '0']);
    await assert.rejects(
      () => sendMessages(args, manager, { pause: async () => {} }),
      /send refused/
    );
    assert.equal(manager.calls.sent.length, 1, 'it stops at the failure');
  });
});

describe('stress run', () => {
  test('the connection is released after a successful run', async () => {
    const manager = managerDouble();
    const code = await runStressTest(await stressArgs(['--count', '2', '--delay', '0']), manager,
      { pause: async () => {} });
    assert.equal(code, 0);
    assert.equal(manager.calls.cleanups, 1, 'cleanup ran');
    assert.equal(manager.calls.sent.length, 2);
  });

  // The point of the finally: a failure must still release the connection.
  test('the connection is released after a failure, and the exit code reports it', async () => {
    const manager = managerDouble({ failOn: 'Test message #1' });
    const code = await runStressTest(await stressArgs(['--count', '3', '--delay', '0']), manager,
      { pause: async () => {} });
    assert.equal(code, 1);
    assert.equal(manager.calls.cleanups, 1, 'cleanup ran despite the failure');
  });

  test('invalid arguments are refused before anything is published', async () => {
    const manager = managerDouble();
    const code = await runStressTest(new ArgumentParser(['--count=abc'], true), manager,
      { pause: async () => {} });
    assert.equal(code, 1);
    assert.deepEqual(manager.calls.sent, []);
    assert.equal(manager.calls.threads, null, 'it never connected');
    assert.equal(manager.calls.cleanups, 1);
  });
});

describe('stress entry point', () => {
  /**
   * Runs the binary with no configuration reachable: the PULSAR_* variables
   * of whoever runs the suite are stripped, and both home directories are
   * pointed away, so a regression in the validation order cannot borrow real
   * credentials. Bounded in time so a hang fails instead of blocking.
   * @param {string[]} args - Command-line arguments
   * @returns {Promise<object>} The exit code and captured output
   */
  async function runStress(args, { bin = STRESS } = {}) {
    const home = await mkdtemp(join(tmpdir(), 'pulsar-companion-home-'));
    const env = { ...process.env };
    for (const name of ['PULSAR_SERVICE_URL', 'PULSAR_TOKEN', 'PULSAR_NAMESPACE']) delete env[name];
    env.HOME = home;
    env.USERPROFILE = home;

    try {
      const { stdout, stderr } = await run(process.execPath, [bin, ...args], { env, timeout: 20000 });
      return { code: 0, out: stdout + stderr };
    } catch (err) {
      assert.notEqual(err.killed, true, `timed out: ${args.join(' ')}`);
      return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  test('--help exits cleanly and documents every option the mode accepts', async () => {
    const { code, out } = await runStress(['--help']);
    assert.equal(code, 0);
    for (const option of ['--topic', '--count', '--delay', '--config', '--compression', '--threads']) {
      assert.ok(out.includes(option), `${option} is undocumented`);
    }
  });

  // npm installs a bin as a symlink, so the binary has to behave the same
  // when launched through one.
  for (const flag of ['--help', '--version']) {
    test(`${flag} behaves identically through a symlinked bin`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pulsar-companion-bin-'));
      const link = join(dir, 'pulsar-companion-stress');
      try {
        await symlink(STRESS, link);
        const direct = await runStress([flag]);
        const linked = await runStress([flag], { bin: link });
        assert.equal(linked.code, direct.code);
        assert.ok(linked.out.length > 0, 'the symlinked bin produced no output');
        assert.equal(linked.out, direct.out);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  test('--version exits cleanly', async () => {
    const { code, out } = await runStress(['--version']);
    assert.equal(code, 0);
    assert.match(out, /pulsar-companion v\d+\.\d+\.\d+/);
  });

  // Validation must precede any announcement or connection, so a typo cannot
  // start publishing.
  for (const bad of ['--count=abc', '--count=-1', '--count=2junk', '--delay=-2', '--delay=2147483648', '--threads=0']) {
    test(`${bad} is refused before any connection`, async () => {
      const { code, out } = await runStress([bad]);
      assert.equal(code, 1);
      assert.doesNotMatch(out, /Starting to send/);
      assert.doesNotMatch(out, /Attempting to connect/);
      assert.match(out, /Invalid value for/);
    });
  }

  test('an unknown option is refused', async () => {
    const { code, out } = await runStress(['--nope']);
    assert.equal(code, 1);
    assert.match(out, /Unknown option '--nope'/);
    assert.doesNotMatch(out, /Attempting to connect/);
  });

  test('an option belonging to another mode is refused', async () => {
    const { code, out } = await runStress(['--send', 'x']);
    assert.equal(code, 1);
    assert.match(out, /cannot be used in STRESS mode/);
  });
});
