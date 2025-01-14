/* eslint-disable @typescript-eslint/no-empty-function */
import { resolve } from 'path';
import { Client, ClientBase, Pool, PoolClient } from 'pg';
import { v4 as uuid } from 'uuid';
import {
  executeTransaction,
  InboxMessage,
  initializeOutboxMessageStorage,
  initializeOutboxService,
  initializeInboxMessageStorage,
  logger,
  OutboxMessage,
  disableLogger,
  initializeInboxService,
} from 'pg-transactional-outbox';
import {
  DockerComposeEnvironment,
  StartedDockerComposeEnvironment,
} from 'testcontainers';
import {
  getConfigs,
  TestConfigs,
  setupTestDb,
  retryCallback,
  isDebugMode,
} from './test-utils';

if (isDebugMode()) {
  jest.setTimeout(600_000);
} else {
  jest.setTimeout(90_000);
  disableLogger(); // Hide logs if the tests are not run in debug mode
}
const aggregateType = 'source_entity';
const messageType = 'source_entity_created';

const createContent = (id: string) => `Content for id ${id}`;

const insertSourceEntity = async (
  loginPool: Pool,
  id: string,
  content: string,
  storeOutboxMessage: ReturnType<typeof initializeOutboxMessageStorage>,
) => {
  await executeTransaction(loginPool, async (client: PoolClient) => {
    const entity = await client.query(
      `INSERT INTO public.source_entities (id, content) VALUES ($1, $2) RETURNING id, content;`,
      [id, content],
    );
    if (entity.rowCount !== 1) {
      throw new Error(
        `Inserted ${entity.rowCount} source entities instead of 1.`,
      );
    }
    await storeOutboxMessage(id, entity.rows[0], client);
  });
};

const compareEntities = (
  { aggregateId: id1 }: { aggregateId: string },
  { aggregateId: id2 }: { aggregateId: string },
) => (id1 > id2 ? 1 : id2 > id1 ? -1 : 0);

const createInfraOutage = async (
  startedEnv: StartedDockerComposeEnvironment,
) => {
  try {
    // Stop the environment and a bit later start the PG container again
    await startedEnv.stop();
  } catch (error) {
    logger().error(error);
  }
  setTimeout(async () => {
    try {
      const postgresContainer = startedEnv.getContainer('postgres-resilience');
      await postgresContainer.restart();
    } catch (error) {
      logger().error(error);
    }
  }, 3000);
};

describe('Outbox and inbox resilience integration tests', () => {
  let dockerEnv: DockerComposeEnvironment;
  let startedEnv: StartedDockerComposeEnvironment;
  let loginPool: Pool;
  let configs: TestConfigs;
  let cleanup: { (): Promise<void> } | undefined = undefined;

  beforeAll(async () => {
    dockerEnv = new DockerComposeEnvironment(
      resolve(__dirname, 'test-utils'),
      'docker-compose-resilience.yml',
    );
    startedEnv = await dockerEnv.up();

    configs = getConfigs(60399);
    await setupTestDb(configs);

    loginPool = new Pool(configs.loginConnection);
    loginPool.on('error', (err) => {
      logger().error(err, 'PostgreSQL pool error');
    });
  });

  afterEach(() => {
    if (cleanup) {
      cleanup().catch((e) => logger().error(e));
    }
  });

  afterAll(() => {
    loginPool?.end().catch((e) => logger().error(e));
    startedEnv?.down().catch((e) => logger().error(e));
  });

  test('Messages are stored and later sent even if the PostgreSQL service goes down', async () => {
    // Arrange
    const entity1Id = uuid();
    const content1 = createContent(entity1Id);
    const entity2Id = uuid();
    const content2 = createContent(entity2Id);
    const sentMessages: OutboxMessage[] = [];
    const storeOutboxMessage = initializeOutboxMessageStorage(
      aggregateType,
      messageType,
      configs.outboxServiceConfig,
    );

    // Act
    // Store two message before starting up the outbox service
    await insertSourceEntity(
      loginPool,
      entity1Id,
      content1,
      storeOutboxMessage,
    );
    await insertSourceEntity(
      loginPool,
      entity2Id,
      content2,
      storeOutboxMessage,
    );
    // Stop the PostgreSQL docker container and restart it after a few seconds while
    // the outbox service starts. The outbox service will retry for a while
    await createInfraOutage(startedEnv);
    // Start the service - it should succeed after PG is up again
    const [shutdown] = initializeOutboxService(
      configs.outboxServiceConfig,
      async (msg) => {
        sentMessages.push(msg);
      },
    );
    cleanup = shutdown;

    // Assert
    await retryCallback(
      async () => {
        if (sentMessages.length !== 2) {
          throw new Error('Messages did not arrive - retry again');
        }
      },
      60_000,
      100,
    );
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages.sort(compareEntities)).toMatchObject(
      [
        {
          aggregateType,
          messageType,
          aggregateId: entity1Id,
          payload: { id: entity1Id, content: content1 },
        },
        {
          aggregateType,
          messageType,
          aggregateId: entity2Id,
          payload: { id: entity2Id, content: content2 },
        },
      ].sort(compareEntities),
    );
  });

  test('Messages are stored in the inbox and fully delivered even if the PostgreSQL service goes down', async () => {
    // Arrange
    const msg1: OutboxMessage = {
      id: uuid(),
      aggregateId: uuid(),
      aggregateType,
      messageType,
      payload: { content: 'some movie' },
      createdAt: '2023-01-18T21:02:27.000Z',
    };
    const msg2: OutboxMessage = {
      ...msg1,
      id: uuid(),
      aggregateId: uuid(),
    };
    const processedMessages: InboxMessage[] = [];
    const [storeInboxMessage, shutdownInboxStorage] =
      await initializeInboxMessageStorage(configs.inboxServiceConfig);

    // Act
    // Store two message before starting up the inbox service
    await storeInboxMessage(msg1);
    await storeInboxMessage(msg2);
    // Stop the PostgreSQL docker container and restart it after a few seconds while
    // the inbox service starts. The inbox service will retry for a while
    await createInfraOutage(startedEnv);
    // Start the service - it should succeed after PG is up again
    const [shutdownInboxSrv] = await initializeInboxService(
      configs.inboxServiceConfig,
      [
        {
          aggregateType,
          messageType,
          handle: async (
            message: InboxMessage,
            client: ClientBase,
          ): Promise<void> => {
            await client.query('SELECT NOW() as now');
            processedMessages.push(message);
          },
        },
      ],
    );
    cleanup = async () => {
      await shutdownInboxStorage();
      await shutdownInboxSrv();
    };

    // Assert
    await retryCallback(
      async () => {
        if (processedMessages.length !== 2) {
          throw new Error('Messages did not arrive - retry again');
        }
      },
      60_000,
      100,
    );
    expect(processedMessages).toHaveLength(2);
    expect(processedMessages.sort(compareEntities)).toMatchObject(
      [msg1, msg2].sort(compareEntities),
    );
  });

  test('Ensure reconnection possible after PostgreSQL outage.', async () => {
    const ensureDbConnection = async () => {
      let client: Client | undefined = undefined;
      try {
        client = new Client(configs.loginConnection);
        await client.connect();
        const one = await client.query(`SELECT 1 as one`);
        expect(one).toMatchObject({
          rowCount: 1,
          rows: [{ one: 1 }],
        });
      } finally {
        await client?.end();
      }
    };

    await ensureDbConnection();
    await createInfraOutage(startedEnv);
    await retryCallback(ensureDbConnection, 10_000, 100);
  });
});
