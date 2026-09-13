# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-13

### Added

- Positional arguments for topic, subscription and key (e.g. `pulsar-companion myTopic my_sub`); matching flags take precedence. A trailing positional the current mode ignores now produces a warning instead of being silently dropped.
- `--config <path>` to read the connection from a chosen file. A path that does not exist is an error rather than a prompt, and an explicitly chosen file is never overridden by the environment.
- `PULSAR_SERVICE_URL`, `PULSAR_TOKEN` and `PULSAR_NAMESPACE` as an alternative to the configuration file. All three are required together, so one cluster's URL cannot be paired with another's token, and a token read from the environment is never written to disk.
- Graceful shutdown: interrupt signals (Ctrl+C, `SIGTERM`) close Pulsar resources cleanly, in the main CLI and in the stress test.
- `engines` field requiring Node.js `^22.13.0 || >=23.5.0`, matching what the dependency tree actually supports: `@inquirer/prompts` and its packages exclude Node 23.0 to 23.4.
- A unit test suite (`npm test`), which needs neither a network nor a cluster. Validated on Node.js 22.13 (the declared minimum), 22.22 and 26.8.

### Changed

- CLI arguments are parsed with `node:util.parseArgs`: unknown options and missing values are rejected with clear messages, and `--option=value` is supported.
- `pulsar+ssl://` connections now verify that the broker's certificate was issued for the host being connected to, not merely that it is valid. The C++ client defaults this check to off, which accepted any certificate trusted by a public CA and left the authentication token exposed to an active interceptor. **A host the certificate does not cover is now refused**, so connecting by an address absent from the certificate's subject alternative names stops working.
- Reader messages are delivered through a listener instead of `readNext()` (see *Fixed*).
- `--threads` is accepted in every mode, and honoured by the stress test; it configures the client's IO threads, not the producer.
- `npm test` runs the unit tests. The stress test moved to `npm run stress`, so a reflexive `npm test` no longer publishes a hundred messages to a real cluster. Note that a bare `node --test` matches `stress-test.js` under the runner's default patterns and would publish to the configured cluster, which is why the script names the test files explicitly.
- Configuration errors name the file at fault, and the library reports them instead of calling `process.exit`.
- Without a configuration and without a terminal to prompt on, the CLI exits with a message naming what to set, instead of failing inside an unanswerable prompt.
- Dependencies bumped: `pulsar-client` to ^1.17, `@inquirer/prompts` to ^8.4; `node-tar` updated past its known advisories.

### Fixed

- Interrupting a reader (`--since`) crashed the process with `SIGSEGV` instead of shutting down. On any `readNext()` failure — a close, a timeout, a disconnection — the C wrapper leaves its output pointer untouched ([`lib/c/c_Reader.cc`](https://github.com/apache/pulsar-client-cpp/blob/v4.1.0/lib/c/c_Reader.cc) assigns it only on success), and the Node binding then wraps and frees that uninitialised pointer ([`src/Reader.cc`](https://github.com/apache/pulsar-client-node/blob/v1.17.0/src/Reader.cc) builds the `shared_ptr` unconditionally). Messages are now delivered through `ReaderConfig.listener`, so `readNext()` is never called. The same defect is present in 1.18.0, so bumping the dependency does not remove the need for this.
- `--compression zlib` was silently ignored: the client matches compression names case-sensitively and falls back to no compression on anything else, so the uppercased `ZLIB` disabled it. Names are now mapped to the exact spellings the client expects.
- A failing producer or consumer during cleanup prevented the Pulsar client, and its IO threads, from being closed.
- A malformed configuration file no longer echoes its own contents. `JSON.parse` quotes the text around a syntax error, so a truncated file, or one holding a bare token, leaked part of that credential into stderr and into CI logs. The error now reports the path and the line only.
- Configuration values are checked before use: a file containing `null`, an array, or a field that is not a string reported a `TypeError` naming neither the field nor the file, and the same check now applies to values read from the environment.
- `--threads` silently accepted values it then ignored (`0`, `abc`, `1e3`, `0x10`, an empty value); validation and the getter now parse identically, and reject anything that is not an integer in 1..2147483647.
- `--count` and `--delay` are validated before the stress test connects, rather than falling back to their defaults on a value like `abc` or `2junk`. Zero remains valid for both.
- The stress test no longer waits for the delay after its last message.
- A failure while printing a received message reported an error and left the run hanging forever; it now exits with a non-zero status.
- A reader whose timestamp seek failed was left open.
- Options that name something (`--config`, `--topic`, `--sub`, `--type`, `--since`, `--compression`) no longer accept an empty value, which the hand-rolled parser used to refuse. An empty `--config` was the dangerous case: it looked like no `--config` at all and fell back to the environment, so a script invoked with an unset path could publish to a different cluster than the one it named. `--send` and `--key` still accept an empty value, since those carry data rather than a name.
- `--send` and `--key` values are no longer trimmed: a payload with leading, trailing or surrounding whitespace was altered before being published, and a key given as a flag disagreed with the same key given positionally. Names and settings are still trimmed.
- `--topic <name>` is no longer rejected as an invalid read position.
- `--count` and `--delay` are now honoured by the stress test, including the value `0`.
- The stress test releases its Pulsar connection when it finishes.
- The configuration file is created with owner-only permissions (`0600`), and an existing one is restored to them on load where the filesystem allows it.
- The main CLI cleans up resources when exiting on error.
- User configuration is loaded only once per run.
- The stress test validates its arguments before connecting or sending anything.

### Removed

- Unreachable read-position handling and a non-functional KeyShared auto-switch.

### Known limitations

- While a timestamped reader repositions, a message published in that instant can be printed before older history, so the first lines are not guaranteed to be chronological. The CLI prints everything the reader hands it during that startup rather than discarding any of it.
- Redeliveries caused by the repositioning are filtered on a best-effort basis, bounded to 10000 message ids. Past that bound a duplicate line is accepted rather than letting memory grow without limit. This is not exactly-once delivery.
- Closing a consumer or producer while it is still being created leaves that late resource unclosed on the JavaScript side. `client.close()` is still attempted natively, and no broker-side leak was observed, but none was ruled out either.
