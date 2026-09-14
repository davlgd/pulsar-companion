#!/usr/bin/env node

import { ArgumentParser } from './src/ArgumentParser.js';
import { PulsarManager } from './src/PulsarManager.js';
import { CONFIG } from './src/config.js';
import { runStressTest } from './src/stress.js';

const argParser = new ArgumentParser(process.argv.slice(2), true);
const pulsarManager = new PulsarManager(CONFIG, argParser);

await runStressTest(argParser, pulsarManager);
