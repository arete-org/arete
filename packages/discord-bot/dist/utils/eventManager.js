/**
 * @file eventManager.ts
 * @description Manages loading and handling Discord.js events.
 * Handles dynamic loading of event handlers and binding them to Discord client events.
 */
import path from 'path';
import { readdir } from 'fs/promises';
import { logger } from './logger.js';
/**
 * Manages Discord.js events for the bot.
 * Handles dynamic loading of event handlers and binding them to Discord client events.
 * @class EventManager
 */
export class EventManager {
    client;
    /** Collection of loaded event handlers */
    events = [];
    /** Dependencies to be injected into event handlers */
    dependencies;
    /**
     * Creates an instance of EventManager.
     * @param {Client} client - The Discord.js client instance
     * @param {Record<string, any>} [dependencies={}] - Dependencies to inject into event handlers
     */
    constructor(client, dependencies = {}) {
        this.client = client;
        this.dependencies = dependencies;
    }
    /**
     * Loads event handlers from the specified directory.
     * @async
     * @param {string} eventsPath - Path to the directory containing event handlers
     * @returns {Promise<void>}
     * @throws {Error} If there's an error loading events
     */
    async loadEvents(eventsPath) {
        try {
            logger.debug(`Loading events from: ${eventsPath}`);
            const isDev = process.env.NODE_ENV !== 'production';
            // Get all files in the events directory
            const eventFiles = (await readdir(eventsPath))
                .filter(file => {
                // Skip non-JS/TS files and declaration files
                if (file.endsWith('.d.ts'))
                    return false;
                // In development, accept both .ts and .js files
                // In production, only accept .js files
                const isJsFile = file.endsWith('.js');
                const isTsFile = file.endsWith('.ts');
                if (!isJsFile && !isTsFile)
                    return false;
                if (!isDev && !isJsFile)
                    return false;
                // Skip the base Event file
                return file !== 'Event.ts' && file !== 'Event.js';
            });
            logger.debug(`Found ${eventFiles.length} event files in ${eventsPath}`);
            for (const file of eventFiles) {
                logger.debug(`Attempting to load event from: ${file}`);
                try {
                    // In development, use the file as is
                    // In production, ensure we're importing the .js file
                    const importFile = isDev ? file : file.replace(/\.ts$/, '.js');
                    const importPath = `file://${path.resolve(eventsPath, importFile).replace(/\\/g, '/')}`;
                    logger.debug(`Importing event from: ${importPath}`);
                    // Import the module
                    const module = await import(importPath);
                    // Get the default export or the first class that has an execute method
                    let EventClass = module.default;
                    // If no default export, look for a named export with the same name as the file
                    if (!EventClass) {
                        const className = file.replace(/\.(js|ts)$/, '');
                        EventClass = module[className];
                    }
                    // Check if we found a valid event class
                    if (typeof EventClass === 'function' && EventClass.prototype &&
                        typeof EventClass.prototype.execute === 'function') {
                        let instantiated = false;
                        // Try (dependencies)
                        try {
                            const event = new EventClass(this.dependencies);
                            this.events.push(event);
                            instantiated = true;
                            logger.debug(`Successfully loaded event (deps ctor): ${file}`);
                        }
                        catch { }
                        // Try (client)
                        if (!instantiated) {
                            try {
                                const event = new EventClass(this.client);
                                this.events.push(event);
                                instantiated = true;
                                logger.debug(`Successfully loaded event (client ctor): ${file}`);
                            }
                            catch { }
                        }
                        // Try () no-arg
                        if (!instantiated) {
                            try {
                                const event = new EventClass();
                                this.events.push(event);
                                instantiated = true;
                                logger.debug(`Successfully loaded event (no-arg ctor): ${file}`);
                            }
                            catch (error) {
                                logger.error(`Failed to instantiate event from ${file}:`, error);
                            }
                        }
                    }
                    else {
                        logger.warn(`Skipping ${file}: No valid event class found`);
                    }
                }
                catch (error) {
                    logger.error(`Error loading event from ${file}:`, error);
                }
            }
            logger.info(`Successfully loaded ${this.events.length} events.`);
        }
        catch (error) {
            logger.error('Failed to load events:', error);
            throw error;
        }
    }
    /**
     * Registers all loaded events with the Discord client.
     * Ensures each event is only registered once to prevent duplicates.
     */
    registerAll() {
        const registeredEvents = new Set();
        for (const event of this.events) {
            // Skip if this event name has already been registered
            if (registeredEvents.has(event.name)) {
                logger.warn(`Skipping duplicate registration for event: ${event.name}`);
                continue;
            }
            // Register the event
            if (event.once) {
                this.client.once(event.name, (...args) => event.execute(...args));
            }
            else {
                this.client.on(event.name, (...args) => event.execute(...args));
            }
            // Track that we've registered this event name
            registeredEvents.add(event.name);
            logger.debug(`Registered event: ${event.name} (${event.once ? 'once' : 'on'})`);
        }
        logger.info(`Registered ${this.events.length} events.`);
    }
    /**
     * Gets the number of loaded events.
     * @returns {number} Number of loaded events
     */
    getEventCount() {
        return this.events.length;
    }
}
//# sourceMappingURL=eventManager.js.map