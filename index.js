#!/usr/bin/env node

import { CONFIG } from './src/config.js';
import { PulsarManager } from './src/PulsarManager.js';
import { ArgumentParser } from './src/ArgumentParser.js';

async function main() {
  const argParser = new ArgumentParser(process.argv.slice(2));
  const pulsarManager = new PulsarManager(CONFIG, argParser);

  try {
    await argParser.validateArgs();
    await pulsarManager.connect(argParser.getThreads());

    if (argParser.hasParam('since')) {
      await pulsarManager.createConsumer(null, argParser.getSinceValue());
      await pulsarManager.receiveMessages();
    } else if (argParser.hasParam('send')) {
      await pulsarManager.createProducer(argParser.getCompression());
      await pulsarManager.sendMessage(argParser.getValue('send'), argParser.getValue('key') || CONFIG.defaultKey);
      console.log('Message sent successfully');
    } else {
      await pulsarManager.createConsumer(argParser.getSubscriptionType(), argParser.getReadPosition());
      await pulsarManager.receiveMessages();
    }
  }
  // If an error occurs, log it and exit the process after some cleaning
  catch (err) {
    console.error("[Error]", err.message);
    process.exit(1);
  }
  finally {
    await pulsarManager.cleanup();
  }
}

main();
