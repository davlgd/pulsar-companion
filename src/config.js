export const CONFIG = {
  defaultCompression: 'NONE',
  defaultKey: "default",
  defaultReadPosition: 'latest',
  defaultThreads: 1,
  defaultTopic: 'pulsar_companion',
  defaultType: 'Exclusive',
  subscription: {
    defaultName: 'pulsar_companion_sub'
  },
  validCompressionTypes: ['NONE', 'LZ4', 'ZLIB', 'ZSTD', 'SNAPPY'],
  validReadPositions: ['earliest', 'latest'],
  validTypes: ['Exclusive', 'Failover', 'Shared', 'KeyShared'],
  pulsar: {
    timeouts: {
      ackMessage: 10000,
      operation: 30,
      readMessage: 30000,
      sendMessage: 30000
    }
  },
  reader: {
    maxMessages: 100,
    queueSize: 1000
  },
  stress: {
    defaultCount: 100,
    defaultDelay: 10
  },
  help: {
    main: `
Pulsar Companion - A companion CLI tool for Apache Pulsar

Usage:
  npx pulsar-companion [options]

Common Options:
  --topic <name>            Specify topic name (default: pulsar_companion_topic)
  -h, --help                Show this help message
  -v, --version             Show version

Producer Options:
  --send <message>          Send a message to the topic
  --key <key>               Set message key
  -t, --threads <n>         Number of IO threads (default: 1)
  -c, --compression <type>  Compression type (default: NONE)
                              Valid types: NONE, LZ4, ZLIB, ZSTD, SNAPPY

Consumer Options:
  --type <type>             Set subscription type (default: Exclusive)
                              Valid types: Exclusive, Failover, Shared, KeyShared
  -s, --sub <name>          Set subscription name (default: pulsar_companion_sub)
  --since <value>           Read messages without subscription from a position
                              Values: earliest, latest
                              Or ISO 8601 timestamp (e.g., "2024-01-20T10:00:00Z")

Examples:
  # Producer examples
  npx pulsar-companion --send "Hello" --topic "myTopic"
  npx pulsar-companion --send "Hello" --key "key1" --topic "myTopic"

  # Consumer examples
  npx pulsar-companion --topic "myTopic" --type "Failover" -s "my_sub"
  npx pulsar-companion --topic "myTopic" --since earliest
  npx pulsar-companion --topic "myTopic" --since "2024-01-20T10:00:00Z"
`,
    stress: `
Pulsar Companion Stress Test Tool

Usage:
  npx pulsar-companion-stress [options]

Options:
  --topic <name>      Specify topic name (default: testNode)
  --count <number>    Number of messages to send (default: 100)
  --delay <ms>        Delay between messages in ms (default: 100)
  -h, --help          Show this help message
  -v, --version       Show version

Examples:
  npx pulsar-companion-stress --count 1000 --delay 50 --topic "myTopic"
  npx pulsar-companion-stress --topic "testTopic" --count 500
`
  }
};
