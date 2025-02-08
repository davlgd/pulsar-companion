import Pulsar from 'pulsar-client';
import { CONFIG } from './config.js';
import { ConfigManager } from './ConfigManager.js';
import { PulsarProducer } from './PulsarProducer.js';
import { PulsarConsumer } from './PulsarConsumer.js';

/**
 * Manages the Pulsar client, producer, and consumer
 * @class
 * @property {object} config - The configuration object
 * @property {ConfigManager} configManager - The configuration manager instance
 * @property {Pulsar.Client} client - The Pulsar client instance
 * @property {PulsarProducer} producer - The Pulsar producer instance
 * @property {PulsarConsumer} consumer - The Pulsar consumer instance
 * @property {ArgumentParser} argParser - The argument parser instance
 * @exports PulsarManager
*/
export class PulsarManager {
  /**
   * Creates an instance of PulsarManager
   * @param {object} config - The configuration object
   * @param {ArgumentParser} argParser - The argument parser instance
   */
  constructor(config, argParser) {
    this.config = config;
    this.configManager = new ConfigManager();
    this.client = null;
    this.producer = null;
    this.consumer = null;
    this.argParser = argParser;
  }

  /**
   * Retrieves the namespace from the user configuration
   * @returns {Promise<string>} The namespace
   */
  async getNamespace() {
    const userConfig = await this.configManager.loadUserConfig();
    return userConfig.namespace;
  }

  /**
   * Constructs the full topic name using the namespace and suffix
   * @returns {Promise<string>} The full topic name
   */
  async getTopicName() {
    const namespace = await this.getNamespace();
    const suffix = this.argParser.getValue('topic') || this.config.defaultTopic;
    return `${namespace}${suffix}`;
  }

  /**
   * Connects to the Pulsar broker
   * @param {number} [ioThreads=CONFIG.defaultThreads] - Number of IO threads
   * @returns {Promise<void>}
   */
  async connect(ioThreads = CONFIG.defaultThreads) {
    const userConfig = await this.configManager.loadUserConfig();
    const clientConfig = {
      serviceUrl: userConfig.serviceUrl,
      authentication: new Pulsar.AuthenticationToken({ token: userConfig.token }),
      operationTimeoutSeconds: this.config.pulsar.timeouts.operation,
      ioThreads
    };

    this.client = new Pulsar.Client(clientConfig);
    console.log('Attempting to connect to Pulsar broker...');
  }

  /**
   * Creates a producer with the provided compression type
   * @param {string} compression - The compression type
   * @returns {Promise<void>}
   */
  async createProducer(compression) {
    const fullTopicName = await this.getTopicName();
    this.producer = new PulsarProducer(this.client, this.config);
    await this.producer.create(fullTopicName, compression);
  }

  /**
   * Creates a consumer with the specified subscription type and read position
   * @param {string|null} subscriptionType - The subscription type
   * @param {string|number} readPosition - The read position or timestamp
   * @returns {Promise<void>}
   */
  async createConsumer(subscriptionType, readPosition) {
    const fullTopicName = await this.getTopicName();
    this.consumer = new PulsarConsumer(this.client, this.config, this.argParser);
    await this.consumer.create(fullTopicName, subscriptionType, readPosition);
  }

  /**
   * Sends a message using the producer
   * @param {string} message - The message to send
   * @param {string} key - The message key
   * @returns {Promise<void>}
   */
  async sendMessage(message, key) {
    await this.producer.sendMessage(message, key);
  }

  /**
   * Receives messages from the consumer
   * @returns {Promise<void>}
   */
  async receiveMessages() {
    await this.consumer.receiveMessages();
  }

  /**
   * Cleans up resources by closing the producer, consumer, and client
   * @returns {Promise<void>}
   */
  async cleanup() {
    if (this.producer) {
      await this.producer.close();
    }
    if (this.consumer) {
      await this.consumer.close();
    }
    if (this.client) {
      await this.client.close();
      console.log('Client closed');
    }
  }
}
