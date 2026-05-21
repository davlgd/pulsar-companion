#!/usr/bin/env node

import { ArgumentParser } from './src/ArgumentParser.js';
import { PulsarManager } from './src/PulsarManager.js';
import { CONFIG } from './src/config.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Parses an integer argument, falling back to a default when absent or invalid
 * @param {string|null} value - The raw argument value
 * @param {number} fallback - The default to use when value is not a number
 * @returns {number} The parsed integer or the fallback
 */
const toInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

async function main() {
  const argParser = new ArgumentParser(process.argv.slice(2), true);
  const pulsarManager = new PulsarManager(CONFIG, argParser);

  try {
    await argParser.validateArgs();

    const topic = argParser.getValue('topic') || CONFIG.defaultTopic;
    const messageCount = toInt(argParser.getValue('count'), CONFIG.stress.defaultCount);
    const delayMs = toInt(argParser.getValue('delay'), CONFIG.stress.defaultDelay);

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
        await sleep(delayMs);
      }
    }
    console.log('Test completed successfully!');
  } catch (err) {
    console.error("Error during test:", err.message);
    process.exitCode = 1;
  } finally {
    await pulsarManager.cleanup();
  }
}

main();
