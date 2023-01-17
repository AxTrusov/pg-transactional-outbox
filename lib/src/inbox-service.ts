import { ClientBase, ClientConfig, Pool } from 'pg';
import {
  InboxMessage,
  InboxError,
  verifyInbox,
  ackInbox,
  nackInbox,
} from './inbox';
import { createService, ServiceConfig } from './local-replication-service';
import { logger } from './logger';
import { executeTransaction } from './utils';

/** The inbox service configuration */
export interface InboxServiceConfig extends ServiceConfig {
  /**
   * Database connection details. The user needs update permission to the inbox.
   */
  pgConfig: ClientConfig;
}

/**
 * Message handler for a specific aggregate type and event type.
 */
export interface InboxMessageHandler {
  /** The aggregate root type */
  aggregateType: string;
  /** The name of the event created for the aggregate type. */
  eventType: string;
  /**
   * Custom business logic to handle a message that was stored in the inbox.
   * @param message The inbox message with the payload to handle.
   * @param client The database client that is part of a transaction to safely handle the inbox message.
   * @throws If something failed and the inbox message should NOT be acknowledged - throw an error.
   */
  handle: (message: InboxMessage, client: ClientBase) => Promise<void>;
}

/**
 * Initialize the service to watch for inbox table inserts.
 * @param config The configuration object with required values to connect to the WAL.
 * @param messageHandlers A list of message handlers to handle the inbox messages. I
 * @returns Functions for a clean shutdown and to help testing "outages" of the inbox service
 */
export const initializeInboxService = async (
  config: InboxServiceConfig,
  messageHandlers: InboxMessageHandler[],
): Promise<[shutdown: { (): Promise<void> }]> => {
  const pool = createPgPool(config);
  const messageHandler = createMessageHandler(messageHandlers, pool, config);
  const errorResolver = createErrorResolver(pool, config);
  const [shutdown] = await createService(
    config,
    messageHandler,
    errorResolver,
    mapInboxRetries,
  );
  return [
    async () => {
      pool.removeAllListeners();
      pool
        .end()
        .catch((e) => logger().error(e, 'PostgreSQL pool shutdown error'));
      shutdown().catch((e) =>
        logger().error(e, 'Inbox service shutdown error'),
      );
    },
  ];
};

const createPgPool = (config: InboxServiceConfig) => {
  const pool = new Pool(config.pgConfig);
  pool.on('error', (err) => {
    logger().error(err, 'PostgreSQL pool error');
  });
  return pool;
};

/**
 * Executes the inbox verification, the actual message handler, and marks the
 * inbox message as processed in one transaction.
 */
const createMessageHandler = (
  messageHandlers: InboxMessageHandler[],
  pool: Pool,
  config: InboxServiceConfig,
) => {
  return async (message: InboxMessage) => {
    await executeTransaction(pool, async (client) => {
      const result = await verifyInbox(message, client, config);
      if (result === true) {
        await Promise.all(
          messageHandlers
            .filter(
              ({ aggregateType, eventType }) =>
                aggregateType === message.aggregateType &&
                eventType === message.eventType,
            )
            .map(({ handle }) => handle(message, client)),
        );
        await ackInbox(message, client, config);
      } else {
        logger().warn(
          message,
          `Received inbox message cannot be processed: ${result}`,
        );
      }
    });
  };
};

/** Returns true if it is a transient error and should be retried - otherwise false. */
const isTransientError = (error: unknown) =>
  !(
    error instanceof InboxError &&
    (error.code === 'ALREADY_PROCESSED' ||
      error.code === 'INBOX_MESSAGE_NOT_FOUND')
  );

/**
 * Handle specific error cases (message already processed/not found) by
 * acknowledging the inbox WAL message. For other errors: increase the retry
 * counter of the message and retry it later.
 */
const createErrorResolver = (pool: Pool, config: InboxServiceConfig) => {
  /**
   * An error handler that will increase the inbox retries count on transient errors.
   * It returns true if the message should be retried.
   * @returns true to retry the message - otherwise false
   */
  return async (error: Error, message: InboxMessage): Promise<boolean> => {
    try {
      if (isTransientError(error)) {
        return true;
      } else {
        return await executeTransaction(pool, async (client) => {
          const action = await nackInbox(message, client, config);
          if (action === 'RETRIES_EXCEEDED') {
            return false;
          } else {
            return true;
          }
        });
      }
    } catch (error) {
      logger().error(
        { ...message, err: error },
        'The message handling error handling failed.',
      );
      return true;
    }
  };
};

/** The local replication service maps by default only the outbox properties */
const mapInboxRetries = (input: object) => {
  if ('retries' in input && typeof input.retries === 'number') {
    return { retries: input.retries };
  }
  return {};
};
