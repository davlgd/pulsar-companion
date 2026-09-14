import { CONFIG } from './config.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Publishes the requested messages
 * @param {ArgumentParser} argParser - The validated argument parser
 * @param {PulsarManager} pulsarManager - The manager to publish through
 * @param {object} [options] - Injection points
 * @param {Function} [options.pause=sleep] - Waits between messages
 * @returns {Promise<void>}
 */
export async function sendMessages(argParser, pulsarManager, { pause = sleep } = {}) {
  const topic = argParser.getSetting('topic') || CONFIG.defaultTopic;
  const messageCount = parseInt(argParser.getValue('count')) || CONFIG.stress.defaultCount;
  const delayMs = parseInt(argParser.getValue('delay')) || CONFIG.stress.defaultDelay;

  console.log(`Starting to send ${messageCount} messages to topic ${topic}`);
  console.log(`Delay between messages: ${delayMs}ms`);

  await pulsarManager.connect();
  await pulsarManager.createProducer(argParser.getCompression());

  for (let i = 1; i <= messageCount; i++) {
    const message = `Test message #${i}`;
    await pulsarManager.sendMessage(message, `key-${i % 5}`);

    if (i % 10 === 0) {
      console.log(`Progress: ${i}/${messageCount} messages sent`);
    }

    if (delayMs > 0) {
      await pause(delayMs);
    }
  }
  console.log('Test completed successfully!');
}

/**
 * Runs a stress test end to end. Lives here rather than in the binary so the
 * tests can drive the very code the binary runs, with a manager double and
 * their own timer, instead of a copy of its orchestration.
 * @param {ArgumentParser} argParser - The argument parser instance
 * @param {PulsarManager} pulsarManager - The manager to publish through
 * @param {object} [options] - Injection points
 * @param {Function} [options.pause=sleep] - Waits between messages
 * @returns {Promise<void>}
 */
export async function runStressTest(argParser, pulsarManager, { pause = sleep } = {}) {
  try {
    await argParser.validateArgs();
    await sendMessages(argParser, pulsarManager, { pause });
  } catch (err) {
    console.error("Error during test:", err.message);
    process.exit(1);
  }
}
