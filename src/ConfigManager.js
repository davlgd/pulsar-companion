import { join } from 'path';
import { homedir } from 'os';
import { input, password } from '@inquirer/prompts';
import { readFile, writeFile, mkdir } from 'fs/promises';

/**
 * Manages the user configuration
 * @class
 * @property {string} configPath - The path to the configuration file
 * @property {string} configDir - The path to the configuration directory
 * @exports ConfigManager
 */
export class ConfigManager {
  /**
   * Creates an instance of ConfigManager
   */
  constructor() {
    const configDir = join(homedir(), '.config', 'pulsar-companion');
    this.configPath = join(configDir, 'config.json');
    this.configDir = configDir;
  }

  /**
   * Loads the user configuration from file
   * @returns {Promise<object>} The configuration object
   */
  async loadUserConfig() {
    try {
      const configContent = await readFile(this.configPath, 'utf8');
      const config = JSON.parse(configContent);

      if (!config.serviceUrl) {
        throw new Error('Missing serviceUrl in config file');
      }
      if (!config.token) {
        throw new Error('Missing token in config file');
      }
      if (!config.namespace) {
        throw new Error('Missing namespace in config file');
      }

      if (!config.namespace.endsWith('/')) {
        config.namespace += '/';
      }
      if (!config.namespace.startsWith('persistent://')) {
        config.namespace = `persistent://${config.namespace}`;
      }

      return config;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return await this.createUserConfig();
      }
      throw err;
    }
  }

  /**
   * Prompts the user to create a configuration file
   * @returns {Promise<object>} The newly created configuration object
   */
  async createUserConfig() {
    console.log('No configuration file found. Please provide your Pulsar connection details:');

    const serviceUrl = await input({
      message: 'Enter Pulsar service URL (e.g., pulsar+ssl://host:port):',
      validate: (value) => {
        if (!value) return 'Service URL cannot be empty';
        if (!value.startsWith('pulsar')) return 'Service URL must start with "pulsar://" or "pulsar+ssl://"';
        return true;
      }
    });

    const token = await password({
      message: 'Enter your authentication token:',
      validate: (value) => {
        if (!value) return 'Token cannot be empty';
        return true;
      }
    });

    const namespace = await input({
      message: 'Enter your namespace (e.g., tenant/namespace):',
      validate: (value) => {
        if (!value) return 'Namespace cannot be empty';
        if (!value.includes('/')) return 'Namespace must be in format: tenant/namespace';
        return true;
      }
    });

    const config = { namespace, serviceUrl, token };

    try {
      await mkdir(this.configDir, { recursive: true });
      await writeFile(this.configPath, JSON.stringify(config, null, 2));
      console.log(`Configuration saved to ${this.configPath}`);

      if (!config.namespace.endsWith('/')) {
        config.namespace += '/';
      }

      if (!config.namespace.startsWith('persistent://')) {
        config.namespace = `persistent://${config.namespace}`;
      }

      return config;
    } catch (err) {
      console.error('Error saving configuration:', err);
      process.exit(1);
    }
  }
}
