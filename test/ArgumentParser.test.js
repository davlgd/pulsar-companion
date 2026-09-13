import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ArgumentParser } from '../src/ArgumentParser.js';
import { CONFIG } from '../src/config.js';

/** Collects console.warn output produced while running fn */
const captureWarnings = (fn) => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try { fn(); } finally { console.warn = original; }
  return warnings;
};

describe('integer arguments', () => {
  // Validation and the getters must agree: a value the parser accepts has to
  // survive the getter unchanged, or the CLI silently ignores what was asked.
  const accepted = [['3', 3], ['007', 7], ['1', 1], ['2147483647', 2147483647]];
  for (const [raw, expected] of accepted) {
    test(`--threads=${raw} is accepted and read back as ${expected}`, async () => {
      const parser = new ArgumentParser(['--send', 'x', `--threads=${raw}`]);
      await parser.validateSpecificArgs();
      assert.equal(parser.getThreads(), expected);
    });
  }

  for (const raw of ['abc', '', '1e3', '0x10', '2.5', '2.0', '0', '-1', '2147483648', '2junk']) {
    test(`--threads=${JSON.stringify(raw)} is rejected`, async () => {
      const parser = new ArgumentParser(['--send', 'x', `--threads=${raw}`]);
      await assert.rejects(() => parser.validateSpecificArgs(), /Invalid value for --threads/);
    });
  }

  test('--threads defaults when absent', () => {
    assert.equal(new ArgumentParser(['--send', 'x']).getThreads(), CONFIG.defaultThreads);
  });

  for (const raw of ['abc', '-1', '2junk', '2.5', '2147483648']) {
    test(`stress --count=${raw} is rejected`, async () => {
      const parser = new ArgumentParser([`--count=${raw}`], true);
      await assert.rejects(() => parser.validateSpecificArgs(), /Invalid value for --count/);
    });
    test(`stress --delay=${raw} is rejected`, async () => {
      const parser = new ArgumentParser([`--delay=${raw}`], true);
      await assert.rejects(() => parser.validateSpecificArgs(), /Invalid value for --delay/);
    });
  }

  // Zero is meaningful for both: send nothing, or send without pausing.
  test('stress --count=0 and --delay=0 stay valid', async () => {
    const parser = new ArgumentParser(['--count=0', '--delay=0'], true);
    await parser.validateSpecificArgs();
    assert.equal(parser.getValue('count'), '0');
    assert.equal(parser.getValue('delay'), '0');
  });
});

describe('empty option values', () => {
  // parseArgs accepts an empty string where the previous hand-rolled parser
  // refused one, which turned `--topic ""` into the default topic.
  // Each option is exercised in a mode that accepts it, so the mode check
  // does not mask the one under test.
  const inMode = {
    compression: (value) => ['--send', 'x', '--compression', value],
    config: (value) => ['--send', 'x', '--config', value],
    topic: (value) => ['--send', 'x', '--topic', value],
    since: (value) => ['--since', value],
    sub: (value) => ['--sub', value],
    type: (value) => ['--type', value]
  };

  for (const [param, argv] of Object.entries(inMode)) {
    for (const value of ['', '   ']) {
      test(`--${param} ${JSON.stringify(value)} is rejected`, async () => {
        await assert.rejects(
          () => new ArgumentParser(argv(value)).validateArgs(),
          new RegExp(`Option --${param} needs a value`)
        );
      });
    }
  }

  // The dangerous one: an empty --config used to look like no --config at all,
  // so a script with an unset path fell back to the environment and published
  // to whatever cluster that named.
  test('an empty --config never reaches the configuration layer', async () => {
    const parser = new ArgumentParser(['--send', 'x', '--config', '']);
    await assert.rejects(() => parser.validateArgs(), /Option --config needs a value/);
  });

  // These two carry data, not a name.
  test('an empty --send is a valid payload', async () => {
    const parser = new ArgumentParser(['--send', '']);
    await parser.validateArgs();
    assert.equal(parser.getValue('send'), '');
  });

  test('an empty --key is a valid key', async () => {
    const parser = new ArgumentParser(['--send', 'x', '--key', '']);
    await parser.validateArgs();
    assert.equal(parser.getValue('key'), '');
  });

  // An empty positional still works as a placeholder for a later slot.
  test('an empty positional placeholder is accepted', async () => {
    const parser = new ArgumentParser(['--send', 'x', 'myTopic', '', 'realkey']);
    await parser.validateArgs();
    assert.equal(parser.getValue('key'), 'realkey');
  });
});

describe('compression', () => {
  // pulsar-client matches these strings case-sensitively and silently falls
  // back to no compression on anything else, so the exact spelling matters.
  const canonical = { none: 'None', NONE: 'None', zlib: 'Zlib', ZLIB: 'Zlib', Zlib: 'Zlib',
    lz4: 'LZ4', LZ4: 'LZ4', zstd: 'ZSTD', ZSTD: 'ZSTD', snappy: 'SNAPPY', SNAPPY: 'SNAPPY' };

  for (const [input, expected] of Object.entries(canonical)) {
    test(`--compression ${input} becomes ${expected}`, () => {
      assert.equal(new ArgumentParser(['--send', 'x', '--compression', input]).getCompression(), expected);
    });
  }

  test('defaults to None', () => {
    assert.equal(new ArgumentParser(['--send', 'x']).getCompression(), 'None');
  });

  test('an unknown type is rejected, quoting what the user typed', async () => {
    const parser = new ArgumentParser(['--send', 'x', '--compression', 'gzip']);
    await assert.rejects(() => parser.validateSpecificArgs(), /Invalid compression type: gzip/);
  });
});

describe('modes', () => {
  test('--send selects PRODUCER', () => {
    assert.equal(new ArgumentParser(['--send', 'x']).mode, 'PRODUCER');
  });
  test('--since selects READER', () => {
    assert.equal(new ArgumentParser(['--since', 'latest']).mode, 'READER');
  });
  test('no mode flag selects CONSUMER', () => {
    assert.equal(new ArgumentParser([]).mode, 'CONSUMER');
  });

  test('a flag belonging to another mode is rejected', async () => {
    const parser = new ArgumentParser(['--since', 'latest', '--sub', 'foo']);
    await assert.rejects(() => parser.validateArgs(), /--sub cannot be used in READER mode/);
  });

  // --threads configures the client, so it is not producer-specific.
  for (const args of [['--send', 'x'], [], ['--since', 'latest']]) {
    test(`--threads is accepted alongside ${JSON.stringify(args)}`, async () => {
      await new ArgumentParser([...args, '--threads', '2']).validateArgs();
    });
  }

  test('--config is accepted in every mode', async () => {
    await new ArgumentParser(['--config', '/tmp/x.json']).validateArgs();
    assert.equal(new ArgumentParser(['--config', '/tmp/x.json']).getConfigPath(), '/tmp/x.json');
  });

  test('an unknown option is reported concisely', async () => {
    await assert.rejects(() => new ArgumentParser(['--nope']).validateArgs(), /Unknown option '--nope'/);
  });
});

describe('positional arguments', () => {
  test('they map to topic, subscription and key in order', () => {
    const parser = new ArgumentParser(['myTopic', 'mySub', 'myKey']);
    assert.equal(parser.getValue('topic'), 'myTopic');
    assert.equal(parser.getValue('sub'), 'mySub');
    assert.equal(parser.getValue('key'), 'myKey');
  });

  test('a flag takes precedence over the positional', () => {
    assert.equal(new ArgumentParser(['--topic', 'flagTopic', 'posTopic']).getValue('topic'), 'flagTopic');
  });

  test('more than three are rejected', async () => {
    await assert.rejects(() => new ArgumentParser(['a', 'b', 'c', 'd']).validateArgs(), /Too many positional arguments/);
  });

  // The documented way to pass a producer key needs a subscription placeholder
  // in slot 2, so only a trailing ignored positional is worth warning about.
  test('a trailing positional the mode ignores warns', () => {
    const parser = new ArgumentParser(['--send', 'x', 'topic', 'mykey']);
    const warnings = captureWarnings(() => parser.warnIgnoredPositionals());
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /"mykey" maps to --sub, which PRODUCER mode ignores/);
  });

  test('a placeholder before a used positional stays silent', () => {
    const parser = new ArgumentParser(['--send', 'x', 'topic', 'placeholder', 'realkey']);
    assert.deepEqual(captureWarnings(() => parser.warnIgnoredPositionals()), []);
    assert.equal(parser.getValue('key'), 'realkey');
  });

  test('positionals a mode does use stay silent', () => {
    const parser = new ArgumentParser(['myTopic', 'mySub']);
    assert.deepEqual(captureWarnings(() => parser.warnIgnoredPositionals()), []);
  });
});

describe('--since', () => {
  test('earliest and latest are read positions', () => {
    assert.equal(new ArgumentParser(['--since', 'earliest']).getSinceValue(), 'earliest');
    assert.equal(new ArgumentParser(['--since', 'LATEST']).getSinceValue(), 'latest');
  });

  test('an ISO timestamp becomes epoch milliseconds', () => {
    assert.equal(new ArgumentParser(['--since', '2024-01-20T10:00:00Z']).getSinceValue(),
      Date.parse('2024-01-20T10:00:00Z'));
  });

  test('a value that is neither is rejected', async () => {
    const parser = new ArgumentParser(['--since', 'someday']);
    await assert.rejects(() => parser.validateSpecificArgs(), /Invalid value for --since/);
  });

  // A topic name used to be mistaken for a read position.
  test('--topic alongside --since is not treated as a position', async () => {
    await new ArgumentParser(['--since', 'latest', '--topic', 'myTopic']).validateArgs();
  });
});

describe('subscription type', () => {
  test('defaults to Exclusive', () => {
    assert.equal(new ArgumentParser([]).getSubscriptionType(), CONFIG.defaultType);
  });
  test('an unknown type is rejected', async () => {
    const parser = new ArgumentParser(['--type', 'Nope']);
    await assert.rejects(() => parser.validateSpecificArgs(), /Invalid subscription type: Nope/);
  });
});
