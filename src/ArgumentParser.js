import { CONFIG } from './config.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MODES = {
  PRODUCER: {
    required: ['send'],
    optional: ['compression', 'key', 'threads', 'topic']
  },
  CONSUMER: {
    required: [],
    optional: ['subscription', 'topic', 'type']
  },
  READER: {
    required: ['since'],
    optional: ['topic']
  }
};

/**
 * ArgumentParser class for parsing and validating command-line arguments
 * @class
 * @property {string[]} args - The command-line arguments
 * @property {boolean} isStressTest - Flag indicating stress test mode
 * @property {object} params - The parameter indices
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
    this.args = args;
    this.isStressTest = isStressTest;
    this.params = {
      compression: Math.max(args.indexOf('--compression'), args.indexOf('-c')),
      help: Math.max(args.indexOf('--help'), args.indexOf('-h')),
      key: args.indexOf('--key'),
      send: args.indexOf('--send'),
      since: args.indexOf('--since'),
      subscription: Math.max(args.indexOf('--sub'), args.indexOf('-s')),
      threads: Math.max(args.indexOf('--threads'), args.indexOf('-t')),
      topic: args.indexOf('--topic'),
      type: args.indexOf('--type'),
      version: Math.max(args.indexOf('--version'), args.indexOf('-v'))
    };

    this.mode = this.determineMode();
  }

  /**
   * Determines the execution mode based on provided parameters
   * @returns {string} The determined mode
   */
  determineMode() {
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
   * Retrieves the value associated with a parameter
   * @param {string} param - The parameter name
   * @returns {string|null} The value or null if not present
   */
  getValue(param) {
    // If the parameter is not present, return null, otherwise return the value after the parameter
    return this.params[param] !== -1 ? this.args[this.params[param] + 1]?.trim() : null;
  }

  /**
   * Checks whether a parameter is present
   * @param {string} param - The parameter name
   * @returns {boolean} True if present, false otherwise
   */
  hasParam(param) {
    // If the parameter is present, return true, otherwise return false
    return this.params[param] !== -1;
  }

  /**
   * Validates the provided command-line arguments
   * @returns {Promise<void>}
   */
  async validateArgs() {
    if (this.hasParam('help')) this.showHelp();
    if (this.hasParam('version')) await this.showVersion();

    const mode = MODES[this.mode];

    for (const param of mode.required) {
      if (!this.hasParam(param)) {
        throw new Error(`Missing required parameter --${param} for ${this.mode} mode`);
      }
    }

    const allowedParams = [...mode.required, ...mode.optional, 'help', 'version'];
    for (const [param, index] of Object.entries(this.params)) {
      if (index !== -1 && !allowedParams.includes(param)) {
        throw new Error(`Parameter --${param} cannot be used in ${this.mode} mode`);
      }
    }

    Object.entries(this.params).forEach(([param, index]) => {
      if (index !== -1 && !this.args[index + 1] && !['help', 'version'].includes(param)) {
        throw new Error(`Missing value for parameter --${param}`);
      }
    });

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

    const readPosition = this.getValue('topic');
    if (readPosition && !CONFIG.validReadPositions.includes(readPosition)) {
      throw new Error(`Invalid read position: ${readPosition}\nValid positions: ${CONFIG.validReadPositions.join(', ')}`);
    }

    const since = this.getValue('since');
    if (since) {
      if (!['earliest', 'latest'].includes(since.toLowerCase())) {
        const timestamp = Date.parse(since);
        if (isNaN(timestamp)) {
          throw new Error(
            'Invalid value for --since\n' +
            'Valid values: earliest, latest, or ISO 8601 timestamp (e.g., "2024-01-20T10:00:00Z")'
          );
        }
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
    if (this.hasParam('key')) {
      console.log('Key specified, automatically switching to KeyShared mode');
      return 'KeyShared';
    }

    const requestedType = this.getValue('type');
    if (requestedType && !CONFIG.validTypes.includes(requestedType)) {
      throw new Error(`Invalid subscription type: ${requestedType}\nValid types: ${CONFIG.validTypes.join(', ')}`);
    }

    return requestedType || CONFIG.defaultType;
  }

  /**
   * Throws an error when trying to get topic name
   */
  getTopicName() {
    throw new Error('Use PulsarManager.getTopicName() instead');
  }

  /**
   * Returns the number of threads
   * @returns {number} The number of IO threads
   */
  getThreads() {
    return parseInt(this.getValue('threads')) || CONFIG.defaultThreads;
  }

  /**
   * Returns the compression type in uppercase
   * @returns {string} The compression type
   */
  getCompression() {
    return (this.getValue('compression') || CONFIG.defaultCompression).toUpperCase();
  }

  /**
   * Returns the read position
   * @returns {string} The read position
   */
  getReadPosition() {
    return this.getValue('topic') || CONFIG.defaultReadPosition;
  }

  /**
   * Returns the subscription name
   * @returns {string} The subscription name
   */
  getSubscriptionName() {
    return this.getValue('subscription') || CONFIG.subscription.defaultName;
  }

  /**
   * Returns the since value
   * @returns {string|number|null} The since value
   */
  getSinceValue() {
    const since = this.getValue('since');
    if (!since) return null;
    return ['earliest', 'latest'].includes(since.toLowerCase()) ?
      since.toLowerCase() : new Date(since).getTime();
  }
}
