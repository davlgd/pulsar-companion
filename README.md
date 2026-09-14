# Pulsar Companion

Pulsar Companion is a CLI tool for Apache Pulsar. It allows you to create producers and consumers, send and receive messages, and more.

## Installation

```bash
npm install -g pulsar-companion
```

`pulsar-client` ships a native binding, downloaded by its install script. If
your npm setup blocks install scripts, the CLI fails at startup with
`Cannot find module .../pulsar-client/lib/binding/pulsar.node`. The fix is to
let that package run its install script and reinstall it; its script does two
things, and both are needed:

```bash
# from the directory holding the installed package, global or local
cd "$(npm root -g)/pulsar-companion/node_modules/pulsar-client"   # or ./node_modules/pulsar-client
npx node-pre-gyp install --fallback-to-build   # the binding
node GenCertFile.js                            # the CA bundle used by pulsar+ssl://
```

Skipping the second step is easy to misdiagnose: without the generated CA
bundle, a `pulsar+ssl://` connection can fail with `AuthenticationError`
rather than anything mentioning certificates.

The binding uses Node-API, so it is not tied to one major Node.js version on a
given platform and architecture; the `engines` range and the usual platform
requirements still apply.

## Usage

```bash
# Producer
npx pulsar-companion --send "Hello" --topic "myTopic"

# Consumer
npx pulsar-companion --topic "myTopic" --type "Failover" -s "my_sub"

# Reader
npx pulsar-companion --topic "myTopic" --since "2024-01-20T10:00:00Z"
npx pulsar-companion --topic "myTopic" --since "latest"

# Positional arguments: topic, then subscription, then key (flags take precedence)
npx pulsar-companion myTopic
npx pulsar-companion myTopic my_sub
npx pulsar-companion --send "Hello" myTopic

# About Pulsar Companion
npx pulsar-companion --help
npx pulsar-companion --version
```

An earlier positional may be left empty to reach a later one, keeping its own
default: `--send "Hello" myTopic "" myKey` sets the topic and the key and
leaves the subscription alone. The last positional carries a value, so an
empty topic or subscription there is refused unless the matching flag supplies
it; an empty key is a key, since it is data rather than a name.

Consumers and readers run until interrupted; `Ctrl+C` closes the Pulsar
resources and exits.

### Consumers and readers

A consumer subscribes, so it acknowledges what it reads and the broker keeps a
cursor for it. A subscription is created at the latest position, so a brand-new
subscription shows only messages published from then on; an existing one
resumes from its own cursor and still receives its backlog.

A reader (`--since`) reads without a durable subscription and without manual
acknowledgements, so it leaves no cursor behind for you to manage.
`--since earliest` replays the history the topic still retains — retention may
already have removed older messages. A timestamp in the future is not an error:
the reader warns and starts from the latest position instead.

`pulsar-client` 1.17 and 1.18 can discard deliveries during native reader
creation, before the JavaScript listener receives them. For `--since earliest`
and past timestamps, the CLI therefore starts at the end of the topic and asks
for a timestamp replay once the reader exists, using timestamp 0 for
`earliest`. That mitigates the startup loss observed here, within the history
the topic still retains; it is not a guarantee of loss-free delivery, and the
underlying C++ client can report a successful seek even when the reposition
failed, so completion alone does not confirm a replay. `--since latest` and a
timestamp in the future do not replay, so a message published during creation
may not appear; that remaining case is tracked in
[issue #3](https://github.com/davlgd/pulsar-companion/issues/3).

Both replayed positions — `earliest` and a past timestamp — behave the same
way at startup: while the reader
repositions, a message published in that instant can be printed before the
older history that follows, so the first few lines are not guaranteed to be in
chronological order. Redeliveries caused by the repositioning are filtered on
a best-effort basis, up to 10000 tracked message ids; past that bound a line
may repeat.

## Stress Test

To make some load tests, once this repository is cloned, you can run the
following commands:

```bash
npm run stress
npx pulsar-companion-stress --count 1000 --delay 50 --topic "myTopic"
```

It publishes real messages to the configured cluster.

## Configuration

Pulsar Companion needs a service URL, an authentication token and a namespace.
They are read, in order of precedence, from:

1. `--config <path>`, a JSON file holding `serviceUrl`, `token` and `namespace`.
2. `PULSAR_SERVICE_URL`, `PULSAR_TOKEN` and `PULSAR_NAMESPACE`. All three are
   required together, so a URL cannot end up paired with another cluster's
   token. Values read from the environment are never written to disk.
3. `~/.config/pulsar-companion/config.json`, created interactively on first
   run with owner-only permissions. Loading an existing file tries to restore
   those permissions, but only as a best effort: if the `chmod` fails the file
   is still used, so a file left readable by others can stay that way. Delete
   this file to reset.

```json
{
  "serviceUrl": "pulsar+ssl://localhost:6651",
  "token": "your-token",
  "namespace": "tenant/namespace"
}
```

Without any of these and without a terminal to prompt on — in a pipeline, for
instance — the CLI exits with a message naming what to set.

Connections over `pulsar+ssl://` verify the broker's certificate *and* that it
was issued for the host being connected to, so a host that the certificate does
not cover is refused.

## Contributing

```bash
git clone https://github.com/davlgd/pulsar-companion.git
cd pulsar-companion
npm install
npm test
```

`npm test` runs the unit tests, which need neither a network nor a cluster.

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
