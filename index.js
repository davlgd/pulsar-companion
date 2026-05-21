#!/usr/bin/env node

import { CONFIG } from './src/config.js';
import { PulsarManager } from './src/PulsarManager.js';
import { ArgumentParser } from './src/ArgumentParser.js';

async function main() {
  const argParser = new ArgumentParser(process.argv.slice(2));
  const pulsarManager = new PulsarManager(CONFIG, argParser);

  // Close Pulsar resources cleanly when interrupted; a second signal forces exit
  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await pulsarManager.cleanup();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await argParser.validateArgs();
    await pulsarManager.connect(argParser.getThreads());

    if (argParser.hasParam('since')) {
      await pulsarManager.createConsumer(null);
      await pulsarManager.receiveMessages();
    } else if (argParser.hasParam('send')) {
      await pulsarManager.createProducer(argParser.getCompression());
      await pulsarManager.sendMessage(argParser.getValue('send'), argParser.getValue('key') || CONFIG.defaultKey);
      console.log('Message sent successfully');
    } else {
      await pulsarManager.createConsumer(argParser.getSubscriptionType());
      await pulsarManager.receiveMessages();
    }
  }
  // If an error occurs, log it and let the finally block clean up before exit
  catch (err) {
    console.error("[Error]", err.message);
    process.exitCode = 1;
  }
  finally {
    await pulsarManager.cleanup();
  }
}

main();
