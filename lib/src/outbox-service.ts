import {
  LogicalReplicationService,
  PgoutputPlugin,
  Pgoutput,
} from 'pg-logical-replication';
import { OutboxMessage } from './outbox';
import { logger } from './logger';
import { ClientConfig } from 'pg';

/** The outbox service configuration */
export interface OutboxServiceConfig {
  /**
   * The "pg" library based settings to initialize the PostgreSQL connection for
   * the outbox service (with replication permissions)
   */
  pgReplicationConfig: ClientConfig;
  /** Outbox service specific configurations */
  settings: {
    /** The database schema name where the outbox table is located */
    outboxSchema: string;
    /** The name of the used PostgreSQL replication */
    postgresOutboxPub: string;
    /** The name of the used PostgreSQL logical replication slot */
    postgresOutboxSlot: string;
  };
}

const createService = (
  config: OutboxServiceConfig,
  callback: (message: OutboxMessage) => Promise<void>,
  errorListener: (err: Error) => Promise<void>,
) => {
  const service = new LogicalReplicationService(config.pgReplicationConfig, {
    acknowledge: { auto: false, timeoutSeconds: 0 },
  });
  service.on('data', async (lsn: string, log: Pgoutput.Message) => {
    if (
      log.tag === 'insert' &&
      log.relation.schema === config.settings.outboxSchema &&
      log.relation.name === 'outbox'
    ) {
      const msg = log.new;
      const om = {
        id: msg.id,
        aggregateType: msg.aggregate_type,
        aggregateId: msg.aggregate_id,
        eventType: msg.event_type,
        payload: msg.payload,
        createdAt: msg.created_at,
      };
      logger().trace(om, 'Received an outbox WAL message');
      try {
        await callback(om);
        service.acknowledge(lsn);
      } catch (err) {
        // Do not acknowledge the outbox message in case of a message sending error
        logger().error({ ...om, err }, 'Could not send the message');
      }
    }
  });
  service.on('error', errorListener);
  return service;
};

/**
 * Initialize the service to watch for outbox table inserts via logical replication.
 * @param config The configuration object with required values to connect to the WAL.
 * @param callback The callback is called to actually send the message through a message bus or other means.
 * @returns Functions to help testing "outages" of the outbox service
 */
export const initializeOutboxService = (
  config: OutboxServiceConfig,
  callback: (message: OutboxMessage) => Promise<void>,
): {
  stop: { (): Promise<void> };
  startIfStopped: { (): void };
} => {
  const errorListener = async (err: Error) => {
    logger().error(err);
    // Stop the current instance and create a new instance e.g. if the DB connection failed
    await service.stop();
    service = createService(config, callback, errorListener);
  };

  let service = createService(config, callback, errorListener);
  const plugin = new PgoutputPlugin({
    protoVersion: 1,
    publicationNames: [config.settings.postgresOutboxPub],
  });

  const subscribeToOutboxMessages = (): void => {
    service
      // `.subscribe` will start the replication and continue to listen until it is stopped
      .subscribe(plugin, config.settings.postgresOutboxSlot)
      // Log any error and restart the replication after a small timeout
      // The service will catch up with any events in the WAL once it restarts.
      .catch(logger().error.bind(logger))
      .then(() => {
        setTimeout(subscribeToOutboxMessages, 100);
      });
  };
  subscribeToOutboxMessages();
  return {
    stop: async () => {
      await service.stop();
    },
    startIfStopped: () => {
      if (service.isStop()) {
        subscribeToOutboxMessages();
      }
    },
  };
};