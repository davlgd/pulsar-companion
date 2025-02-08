export class PulsarProducer {
  /**
   * Creates an instance of PulsarProducer
   * @param {Pulsar.Client} client - The Pulsar client instance
   * @param {object} config - The configuration object
   */
  constructor(client, config) {
    this.client = client;
    this.config = config;
    this.producer = null;
  }

  /**
   * Creates a producer on the specified topic
   * @param {string} topicName - The full topic name
   * @param {string} [compression=CONFIG.defaultCompression] - The compression type
   * @returns {Promise<void>}
   */
  async create(topicName, compression = CONFIG.defaultCompression) {
    this.producer = await this.client.createProducer({
      batchingEnabled: true,
      sendTimeoutMs: this.config.pulsar.timeouts.sendMessage,
      compressionType: compression,
      topic: topicName,
    });
    console.log('Producer successfully created on topic:', topicName.split('/').pop());
  }

  /**
   * Sends a message using the producer
   * @param {string} message - The message to send
   * @param {string} key - The partition key
   * @returns {Promise<void>}
   */
  async sendMessage(message, key) {
    if (!this.producer) {
      throw new Error('Producer not initialized. Call create() first.');
    }

    await this.producer.send({
      data: Buffer.from(message),
      partitionKey: key
    });
    console.log(`Message sent: ${message} (key: ${key})`);
  }

  /**
   * Closes the producer
   * @returns {Promise<void>}
   */
  async close() {
    if (this.producer) {
      await this.producer.close();
      console.log('Producer closed');
    }
  }
}
