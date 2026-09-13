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
 * @property {Promise<void>|null} cleanupPromise - Memoized cleanup, so it runs only once
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
    this.cleanupPromise = null;
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
    const suffix = this.argParser.getSetting('topic') || this.config.defaultTopic;
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
      // The C++ client defaults this to false, which accepts a valid
      // certificate issued for any host: the token would then be sent to
      // whoever intercepts the connection.
      tlsValidateHostname: true,
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
   * Creates a consumer with the specified subscription type
   * @param {string|null} subscriptionType - The subscription type
   * @returns {Promise<void>}
   */
  async createConsumer(subscriptionType) {
    const fullTopicName = await this.getTopicName();
    this.consumer = new PulsarConsumer(this.client, this.config, this.argParser);
    await this.consumer.create(fullTopicName, subscriptionType);
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
   * Cleans up resources by closing the producer, consumer, and client.
   * Memoized so concurrent callers (e.g. a signal handler and the finally
   * block) share a single run instead of double-closing resources.
   * @returns {Promise<void>}
   */
  async cleanup() {
    this.cleanupPromise ??= (async () => {
      // Each resource is closed independently: a failing producer or consumer
      // must not keep the client (and its IO threads) from being released.
      for (const resource of [this.producer, this.consumer]) {
        try {
          await resource?.close();
        } catch (err) {
          console.error('[Cleanup]', err.message);
        }
      }

      try {
        if (this.client) {
          await this.client.close();
          console.log('Client closed');
        }
      } catch (err) {
        console.error('[Cleanup]', err.message);
      }
    })();
    return this.cleanupPromise;
  }
}
