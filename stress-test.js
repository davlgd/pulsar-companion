#!/usr/bin/env node

import { ArgumentParser } from './src/ArgumentParser.js';
import { PulsarManager } from './src/PulsarManager.js';
import { CONFIG } from './src/config.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const argParser = new ArgumentParser(process.argv.slice(2), true);
  const topic = argParser.getValue('topic') || CONFIG.defaultTopic;
  const messageCount = parseInt(argParser.getValue('count')) || CONFIG.stress.defaultCount;
  const delayMs = parseInt(argParser.getValue('delay')) || CONFIG.stress.defaultDelay;

  console.log(`Starting to send ${messageCount} messages to topic ${topic}`);
  console.log(`Delay between messages: ${delayMs}ms`);

  const pulsarManager = new PulsarManager(CONFIG, argParser);

  try {
    await argParser.validateArgs();
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
    process.exit(1);
  }
}

main();
