import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONFIG } from './config.js';

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

// Options that name something are meaningless when empty. --send and --key
// carry data instead, so an empty value there is legitimate and kept.
const REQUIRE_VALUE = ['compression', 'config', 'since', 'sub', 'topic', 'type'];

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
 * Parses a plain decimal integer. Unlike parseInt it rejects trailing junk,
 * exponents and hex, so validation and the getters never disagree.
 * @param {string|null|undefined} raw - The raw argument value
 * @returns {number|null} The integer, or null when the value is not one
 */
function parseDecimal(raw) {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

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
        await readFile(join(dirname(import.meta.dirname), 'package.json'), 'utf8')
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

    this.warnIgnoredPositionals();

    // Reject an empty flag before anything reads configuration or connects: an
    // empty --config would otherwise look like no --config at all, and fall
    // back to the environment instead of failing.
    for (const param of REQUIRE_VALUE) {
      const value = this.values[param];
      if (value !== undefined && value.trim() === '') {
        throw new Error(`Option --${param} needs a value`);
      }
    }

    await this.validateSpecificArgs();
  }

  /**
   * Validates an optional argument as a bounded integer
   * @param {string} param - The parameter name
   * @param {number} min - The lowest accepted value
   * @param {number} [max=2147483647] - The highest accepted value (int32)
   * @returns {void}
   */
  validateInteger(param, min, max = 2147483647) {
    const raw = this.getValue(param);
    if (raw === null || raw === undefined) return;

    const value = parseDecimal(raw);
    if (value === null || value < min || value > max) {
      throw new Error(`Invalid value for --${param}: ${JSON.stringify(raw)}\nExpected an integer between ${min} and ${max}`);
    }
  }

  /**
   * Warns about positional arguments the current mode ignores.
   * A positional followed by another one is a placeholder for a later slot
   * (e.g. the subscription slot when passing a key to a producer), so only
   * the last one provided is reported.
   * @returns {void}
   */
  warnIgnoredPositionals() {
    const mode = MODES[this.mode];
    const allowed = [...mode.required, ...mode.optional];
    const slots = ['topic', 'sub', 'key'];

    const last = this.positionals.length - 1;
    if (last < 0) return;

    const param = slots[last];
    if (param && !allowed.includes(param)) {
      console.warn(`[Warning] positional argument "${this.positionals[last]}" maps to --${param}, which ${this.mode} mode ignores`);
    }
  }

  /**
   * Performs specific validations on arguments
   * @returns {Promise<void>}
   */
  async validateSpecificArgs() {
    // Validate the raw values: the getters normalise them, which would hide
    // both a non-numeric argument and an explicit 0.
    this.validateInteger('threads', 1);
    this.validateInteger('count', 0);
    // A larger delay overflows Node's timer and would be clamped to 1ms.
    this.validateInteger('delay', 0);

    const compression = this.getValue('compression');
    if (compression && !(compression.toUpperCase() in CONFIG.compressionTypes)) {
      throw new Error(`Invalid compression type: ${compression}\nValid types: ${Object.keys(CONFIG.compressionTypes).join(', ')}`);
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
    return parseDecimal(this.getValue('threads')) ?? CONFIG.defaultThreads;
  }

  /**
   * Returns the compression type as pulsar-client spells it
   * @returns {string} The canonical compression type
   */
  getCompression() {
    const requested = (this.getValue('compression') || CONFIG.defaultCompression).toUpperCase();
    return CONFIG.compressionTypes[requested] ?? CONFIG.compressionTypes.NONE;
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
