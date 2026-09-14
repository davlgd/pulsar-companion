import Pulsar from 'pulsar-client';

/** Upper bound on message ids tracked to suppress post-seek redeliveries */
const MAX_TRACKED_IDS = 10000;

/**
 * Manages the Pulsar consumer
 * @class
 * @property {Pulsar.Client} client - The Pulsar client instance
 * @property {object} config - The configuration object
 * @property {ArgumentParser} argParser - The argument parser instance
 * @property {Consumer|Reader} consumer - The consumer or reader instance
 * @property {boolean} closed - Whether the consumer has been closed
 * @property {boolean} isReader - Whether this instance wraps a Reader
 * @property {boolean} delivering - Whether reader messages may be printed
 * @property {Promise<void>|null} finished - Resolves when reader delivery ends
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
    this.closed = false;
    this.isReader = argParser.hasParam('since');
    this.delivering = false;
    this.finished = null;
    this.stop = null;
    this.failure = null;
  }

  /**
   * Creates a consumer or reader depending on the parameters
   * @param {string} topicName - The full topic name
   * @param {string|null} subscriptionType - The subscription type
   * @returns {Promise<void>}
   */
  async create(topicName, subscriptionType) {
    this.consumer = this.isReader
      ? await this.createReader(topicName, this.argParser.getSinceValue())
      : await this.createSubscriber(topicName, subscriptionType);
  }

  /**
   * Creates a reader starting from a specified position.
   *
   * Messages are delivered through a listener rather than readNext(): in
   * pulsar-client 1.17 (and 1.18) a failing readNext() frees an uninitialised
   * pointer, so any timeout, disconnection or concurrent close() crashes the
   * process. The listener path never calls readNext at all.
   *
   * @param {string} topicName - The full topic name
   * @param {string|number} sinceValue - The start position or timestamp
   * @returns {Promise<Reader>}
   */
  async createReader(topicName, sinceValue) {
    const seekTo = typeof sinceValue === 'number' && sinceValue <= Date.now()
      ? sinceValue
      : null;

    if (typeof sinceValue === 'number' && seekTo === null) {
      console.warn('[Warning] --since is in the future; reading from latest instead');
    }

    // Create at the end of the topic, then reposition. The binding wires the
    // JavaScript callback only as createReader() settles, and a native
    // delivery that runs before that captured a null wrapper is discarded
    // rather than queued. Starting at the end avoids handing the whole
    // backlog to that path, and the seek below replays the retained history
    // once the callback is registered. It does not stop live messages from
    // arriving during creation, which is a separate limitation: see issue #3.
    const startMessageId = Pulsar.MessageId.latest();
    const seekToEarliest = sinceValue === 'earliest' && seekTo === null;

    this.finished = new Promise((resolve) => { this.stop = resolve; });

    // The seek repositions the reader natively before the awaiting promise
    // resolves, so the listener can fire with wanted history while we still
    // consider ourselves "seeking". Dropping those would lose them for good,
    // so print everything and suppress only the redeliveries the seek causes.
    // Redelivery can start before the seek resolves, so ids are checked on
    // every message, not just once seeking is over.
    let seeking = seekTo !== null || seekToEarliest;
    const printedWhileSeeking = new Set();

    // The native layer waits on whatever this callback returns, so it must
    // never reject and never await close(): it records and returns.
    const listener = (msg) => {
      if (!this.delivering) return;
      try {
        const id = String(msg.getMessageId());
        if (printedWhileSeeking.delete(id)) return;
        // Bounded so a long seek cannot grow this without limit; past the cap
        // a redelivery may be printed twice rather than retained forever.
        if (seeking && printedWhileSeeking.size < MAX_TRACKED_IDS) {
          printedWhileSeeking.add(id);
        }
        this.printMessage(msg);
      } catch (err) {
        // Surface the failure through receiveMessages() instead of letting
        // the run hang: the promise handed to the native layer must not reject.
        this.failure ??= err;
        this.stop?.();
      }
    };

    // Deliver from the moment the reader exists, so no callback we are
    // actually handed is thrown away. It says nothing about deliveries the
    // binding discarded before the callback was registered.
    this.delivering = true;

    const reader = await this.client.createReader({
      receiverQueueSize: this.config.reader.queueSize,
      startMessageId,
      topic: topicName,
      listener
    });

    // Timestamp 0 is the whole retained history, which is what `earliest`
    // asks for. The timestamp form is used for both positions because it is
    // the one this code has exercised; seeking by message id was observed to
    // deliver nothing in the shape tried here, so it is simply not used.
    const seekTarget = seekToEarliest ? 0 : seekTo;
    if (seekTarget !== null) {
      try {
        await reader.seekTimestamp(seekTarget);
      } catch (err) {
        // The reader is not stored on `this` yet, so close it here rather
        // than leaking it, then report the original failure.
        this.delivering = false;
        await reader.close().catch(() => {});
        throw err;
      }
      seeking = false;
    }

    let from = 'latest';
    if (seekTo !== null) from = new Date(seekTo).toISOString();
    else if (seekToEarliest) from = 'earliest';
    console.log(`Reader successfully created, starting from: ${from}`);
    return reader;
  }

  /**
   * Creates a subscriber with the given subscription type
   * @param {string} topicName - The full topic name
   * @param {string} subscriptionType - The subscription type
   * @returns {Promise<Consumer>}
   */
  async createSubscriber(topicName, subscriptionType) {
    const subscription = this.argParser.getSubscriptionName();
    const subscriber = await this.client.subscribe({
      ackTimeoutMs: this.config.pulsar.timeouts.ackMessage,
      subscription,
      subscriptionInitialPosition: 'Latest',
      subscriptionType,
      topic: topicName
    });

    console.log(`Consumer successfully created with subscription ${subscription} (${subscriptionType})`);
    return subscriber;
  }

  /**
   * Receives messages until the consumer is closed
   * @returns {Promise<void>}
   */
  async receiveMessages() {
    // Reader mode is push-based: just wait until close() ends delivery,
    // or until the listener reports a failure.
    if (this.isReader) {
      await this.finished;
      if (this.failure) throw this.failure;
      return;
    }

    while (!this.closed) {
      try {
        const msg = await this.consumer.receive();
        this.printMessage(msg);
        await this.consumer.acknowledge(msg);
      } catch (err) {
        if (err.name === 'TimeoutError') continue;
        // The consumer was closed (e.g. by a shutdown signal): stop cleanly
        if (this.closed) return;
        throw err;
      }
    }
  }

  /**
   * Prints a received message
   * @param {Message} msg - The received message
   * @returns {void}
   */
  printMessage(msg) {
    const timestamp = new Date(msg.getPublishTimestamp()).toISOString();
    console.log(
      `[${timestamp}]`,
      msg.getData().toString(),
      `(key: ${msg.getPartitionKey()},`,
      `ID: ${msg.getMessageId()})`
    );
  }

  /**
   * Stops delivery and closes the consumer
   * @returns {Promise<void>}
   */
  async close() {
    if (!this.consumer || this.closed) return;

    this.closed = true;
    this.delivering = false;
    // Release receiveMessages() before closing, so nothing is in flight.
    this.stop?.();

    await this.consumer.close();
    console.log(this.isReader ? 'Reader closed' : 'Consumer closed');
  }
}
