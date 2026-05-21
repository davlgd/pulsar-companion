import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONFIG } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Option definitions consumed by node:util.parseArgs
 */
const OPTIONS = {
  compression: { type: 'string', short: 'c' },
  count: { type: 'string' },
  delay: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  key: { type: 'string' },
  send: { type: 'string' },
  since: { type: 'string' },
  sub: { type: 'string', short: 's' },
  threads: { type: 'string', short: 't' },
  topic: { type: 'string' },
  type: { type: 'string' },
  version: { type: 'boolean', short: 'v' }
};

const MODES = {
  PRODUCER: {
    required: ['send'],
    optional: ['compression', 'key', 'threads', 'topic']
  },
  CONSUMER: {
    required: [],
    optional: ['sub', 'topic', 'type']
  },
  READER: {
    required: ['since'],
    optional: ['topic']
  },
  STRESS: {
    required: [],
    optional: ['compression', 'count', 'delay', 'topic']
  }
};

/**
 * ArgumentParser class for parsing and validating command-line arguments
 * @class
 * @property {boolean} isStressTest - Flag indicating stress test mode
 * @property {object} values - The parsed option values
 * @property {string[]} positionals - The parsed positional arguments
 * @property {object} positionalParams - Positional arguments mapped to topic, subscription and key
 * @property {Error|null} parseError - A deferred argument-parsing error, if any
 * @property {string} mode - The execution mode
 * @exports ArgumentParser
*/
export class ArgumentParser {
  /**
   * Creates an instance of ArgumentParser
   * @param {string[]} args - The command-line arguments
   * @param {boolean} [isStressTest=false] - Flag indicating stress test mode
   */
  constructor(args, isStressTest = false) {
    this.isStressTest = isStressTest;

    // parseArgs may throw on malformed input; defer that error to validateArgs
    // so --help and --version still work and the message is reported cleanly.
    try {
      const { values, positionals } = parseArgs({
        args,
        options: OPTIONS,
        strict: true,
        allowPositionals: true
      });
      this.values = values;
      this.positionals = positionals;
      this.parseError = null;
    } catch (err) {
      this.values = {};
      this.positionals = [];
      this.parseError = err;
    }

    // Positional arguments map to topic, subscription and key, in that order
    this.positionalParams = {
      topic: this.positionals[0],
      sub: this.positionals[1],
      key: this.positionals[2]
    };

    this.mode = this.determineMode();
  }

  /**
   * Determines the execution mode based on provided parameters
   * @returns {string} The determined mode
   */
  determineMode() {
    if (this.isStressTest) return 'STRESS';
    if (this.hasParam('send')) return 'PRODUCER';
    if (this.hasParam('since')) return 'READER';
    return 'CONSUMER';
  }

  /**
   * Displays help message and exits
   */
  showHelp() {
    console.log(this.isStressTest ? CONFIG.help.stress : CONFIG.help.main);
    process.exit(0);
  }

  /**
   * Displays version information and exits
   * @returns {Promise<void>}
   */
  async showVersion() {
    try {
      const packageJson = JSON.parse(
        await readFile(join(dirname(__dirname), 'package.json'), 'utf8')
      );
      console.log(`${packageJson.name} v${packageJson.version}`);
    } catch (err) {
      console.log(`Error while getting version: ${err}`);
    }
    process.exit(0);
  }

  /**
   * Retrieves the value of a parameter, falling back to positional arguments
   * @param {string} param - The parameter name
   * @returns {string|null} The value or null if not present
   */
  getValue(param) {
    const value = this.values[param];
    if (value !== undefined) {
      return typeof value === 'string' ? value.trim() : value;
    }
    return this.positionalParams[param] ?? null;
  }

  /**
   * Checks whether a parameter is present
   * @param {string} param - The parameter name
   * @returns {boolean} True if present, false otherwise
   */
  hasParam(param) {
    return this.values[param] !== undefined;
  }

  /**
   * Validates the provided command-line arguments
   * @returns {Promise<void>}
   */
  async validateArgs() {
    if (this.hasParam('help')) this.showHelp();
    if (this.hasParam('version')) await this.showVersion();
    if (this.parseError) {
      // parseArgs messages carry a verbose hint; keep only the first sentence
      throw new Error(this.parseError.message.split('. ')[0]);
    }

    if (this.positionals.length > 3) {
      throw new Error('Too many positional arguments (expected: [topic] [subscription] [key])');
    }

    const mode = MODES[this.mode];

    for (const param of mode.required) {
      if (!this.hasParam(param)) {
        throw new Error(`Missing required parameter --${param} for ${this.mode} mode`);
      }
    }

    const allowedParams = [...mode.required, ...mode.optional, 'help', 'version'];
    for (const param of Object.keys(this.values)) {
      if (!allowedParams.includes(param)) {
        throw new Error(`Parameter --${param} cannot be used in ${this.mode} mode`);
      }
    }

    await this.validateSpecificArgs();
  }

  /**
   * Performs specific validations on arguments
   * @returns {Promise<void>}
   */
  async validateSpecificArgs() {
    const threads = this.getThreads();
    if (threads && (isNaN(threads) || threads < 1)) {
      throw new Error('Number of threads must be a positive integer');
    }

    const compression = this.getCompression();
    if (compression && !CONFIG.validCompressionTypes.includes(compression.toUpperCase())) {
      throw new Error(`Invalid compression type: ${compression}\nValid types: ${CONFIG.validCompressionTypes.join(', ')}`);
    }

    const since = this.getValue('since');
    if (since && !CONFIG.validReadPositions.includes(since.toLowerCase())) {
      if (isNaN(Date.parse(since))) {
        throw new Error(
          'Invalid value for --since\n' +
          'Valid values: earliest, latest, or ISO 8601 timestamp (e.g., "2024-01-20T10:00:00Z")'
        );
      }
    }

    const requestedType = this.getValue('type');
    if (requestedType && !CONFIG.validTypes.includes(requestedType)) {
      throw new Error(`Invalid subscription type: ${requestedType}\nValid types: ${CONFIG.validTypes.join(', ')}`);
    }
  }

  /**
   * Returns the subscription type
   * @returns {string} The subscription type
   */
  getSubscriptionType() {
    return this.getValue('type') || CONFIG.defaultType;
  }

  /**
   * Returns the number of threads
   * @returns {number} The number of IO threads
   */
  getThreads() {
    return parseInt(this.getValue('threads'), 10) || CONFIG.defaultThreads;
  }

  /**
   * Returns the compression type in uppercase
   * @returns {string} The compression type
   */
  getCompression() {
    return (this.getValue('compression') || CONFIG.defaultCompression).toUpperCase();
  }

  /**
   * Returns the subscription name
   * @returns {string} The subscription name
   */
  getSubscriptionName() {
    return this.getValue('sub') || CONFIG.subscription.defaultName;
  }

  /**
   * Returns the since value
   * @returns {string|number|null} The since value
   */
  getSinceValue() {
    const since = this.getValue('since');
    if (!since) return null;
    return CONFIG.validReadPositions.includes(since.toLowerCase())
      ? since.toLowerCase()
      : new Date(since).getTime();
  }
}
