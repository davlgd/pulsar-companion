# Pulsar Companion

Pulsar Companion is a CLI tool for Apache Pulsar. It allows you to create producers and consumers, send and receive messages, and more.

## Installation

```bash
npm install -g pulsar-companion
```

## Usage

```bash
# Producer
npx pulsar-companion --send "Hello" --topic "myTopic"

# Consumer
npx pulsar-companion --topic "myTopic" --type "Failover" -s "my_sub"

# Reader
npx pulsar-companion --topic "myTopic" --since "2024-01-20T10:00:00Z"
npx pulsar-companion --topic "myTopic" --since "latest"

# About Pulsar Companion
npx pulsar-companion --help
npx pulsar-companion --version
```

## Stress Test

To make some load tests, once this repository is cloned, you can run the following commands:

```bash
npx pulsar-companion-stress
npx pulsar-companion-stress --count 1000 --delay 50 --topic "myTopic"
```

## Configuration

Configuration is stored in `~/.pulsar-companion/config.json`. Delete this file to reset.

## Contributing

```bash
git clone https://github.com/davlgd/pulsar-companion.git
cd pulsar-companion
npm install
```

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
