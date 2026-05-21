# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-05-21

### Added

- Positional arguments for topic, subscription and key (e.g. `pulsar-companion myTopic my_sub`); matching flags take precedence.
- Graceful shutdown: interrupt signals (Ctrl+C, `SIGTERM`) now close Pulsar resources cleanly.
- `engines` field requiring Node.js >= 22.13.

### Changed

- CLI arguments are parsed with `node:util.parseArgs`: unknown options and missing values are rejected with clear messages, and `--option=value` is supported.
- Dependencies bumped: `pulsar-client` to ^1.17, `@inquirer/prompts` to ^8.4.

### Fixed

- `--topic <name>` is no longer rejected as an invalid read position.
- `--count` and `--delay` are now honoured by the stress test, including the value `0`.
- The stress test releases its Pulsar connection when it finishes.
- The configuration file is created and kept with owner-only permissions (`0600`).
- The main CLI cleans up resources when exiting on error.
- User configuration is loaded only once per run.
- The stress test validates its arguments before printing any output.

### Removed

- Unreachable read-position handling and a non-functional KeyShared auto-switch.
