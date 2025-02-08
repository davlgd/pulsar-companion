import Pulsar from 'pulsar-client';

/**
 * Manages the Pulsar consumer
 * @class
 * @property {Pulsar.Client} client - The Pulsar client instance
 * @property {object} config - The configuration object
 * @property {ArgumentParser} argParser - The argument parser instance
 * @property {Consumer|Reader} consumer - The consumer or reader instance
 * @property {number} messagesToRead - The number of messages to read
 */
export class PulsarConsumer {
  /**
   * Creates an instance of PulsarConsumer
   * @param {Pulsar.Client} client - The Pulsar client instance
   * @param {object} config - The configuration object
   * @param {ArgumentParser} argParser - The argument parser instance
   */
  constructor(client, config, argParser) {
    this.argParser = argParser;
    this.client = client;
    this.config = config;
    this.consumer = null;
    this.messagesToRead = null;
  }

  /**
   * Creates a consumer or reader depending on the parameters
   * @param {string} topicName - The full topic name
   * @param {string|null} subscriptionType - The subscription type
   * @param {string} [readPosition='latest'] - The read position
   * @returns {Promise<void>}
   */
  async create(topicName, subscriptionType, readPosition = 'latest') {
    this.consumer = this.argParser.hasParam('since')
      ? await this.createReader(topicName, this.argParser.getSinceValue())
      : await this.createSubscriber(topicName, subscriptionType);
  }

  /**
   * Creates a reader starting from a specified position
   * @param {string} topicName - The full topic name
   * @param {string|number} sinceValue - The start position or timestamp
   * @returns {Promise<Reader>}
   */
  async createReader(topicName, sinceValue) {
    let startMessageId;

    if (typeof sinceValue === 'string') {

      startMessageId = sinceValue === 'earliest'
        ? Pulsar.MessageId.earliest()
        : Pulsar.MessageId.latest();
    } else {
      startMessageId = Pulsar.MessageId.latest();
    }

    const reader = await this.client.createReader({
      receiverQueueSize: this.config.reader.queueSize,
      startMessageId,
      topic: topicName,
    });

    if (typeof sinceValue === 'number') {

      const now = new Date();

      if (sinceValue < now) {
        await reader.seekTimestamp(sinceValue);
        console.log(`Reader successfully created, starting from: ${new Date(sinceValue).toISOString()}`);
        return reader;
      }
      else {
        sinceValue = 'latest';
      }
    }

    console.log(`Reader successfully created, starting from: ${sinceValue}`);
    return reader;
  }

  /**
   * Creates a subscriber with the given subscription type
   * @param {string} topicName - The full topic name
   * @param {string} subscriptionType - The subscription type
   * @returns {Promise<Consumer>}
   */
  async createSubscriber(topicName, subscriptionType) {
    const subscriber = await this.client.subscribe({
      ackTimeoutMs: this.config.pulsar.timeouts.ackMessage,
      subscription: this.argParser.getSubscriptionName(),
      subscriptionInitialPosition: 'Latest',
      subscriptionType: subscriptionType,
      topic: topicName
    });

    console.log(`Consumer successfully created with subscription ${this.argParser.getSubscriptionName()} (${subscriptionType})`);
    return subscriber;
  }

  /**
   * Receives messages in an infinite loop
   * @returns {Promise<void>}
   */
  async receiveMessages() {
    const isReader = this.argParser.hasParam('since');
    const receiveMethod = isReader ? 'readNext' : 'receive';

    while (true) {
      try {
        const msg = await this.consumer[receiveMethod]();
        await this.handleMessage(msg, isReader);
      } catch (err) {
        if (err.name === 'TimeoutError') continue;
        throw err;
      }
    }
  }

  /**
   * Handles a received message
   * @param {Message} msg - The received message
   * @param {boolean} isReader - Flag indicating if this is a reader
   * @returns {Promise<void>}
   */
  async handleMessage(msg, isReader) {
    const messageId = msg.getMessageId();
    const timestamp = new Date(msg.getPublishTimestamp()).toISOString();
    console.log(
      `[${timestamp}]`,
      msg.getData().toString(),
      `(key: ${msg.getPartitionKey()},`,
      `ID: ${messageId})`
    );

    if (!isReader) {
      await this.consumer.acknowledge(msg);
    }
  }

  /**
   * Closes the consumer
   * @returns {Promise<void>}
   */
  async close() {
    if (this.consumer) {
      await this.consumer.close();
      console.log('Consumer closed');
    }
  }
}
