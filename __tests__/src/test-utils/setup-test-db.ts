import { Client, ClientConfig } from 'pg';
import {
  OutboxServiceConfig,
  InboxServiceConfig,
} from 'pg-transactional-outbox';
import { TestConfigs } from './configs';

export const setupTestDb = async ({
  loginConnection,
  outboxServiceConfig,
  inboxServiceConfig,
}: TestConfigs): Promise<void> => {
  await dbmsSetup(loginConnection, outboxServiceConfig, inboxServiceConfig);
  await outboxSetup(loginConnection, outboxServiceConfig);
  await inboxSetup(loginConnection, inboxServiceConfig);
};

/** Setup on the PostgreSQL server level (and not within a DB) */
const dbmsSetup = async (
  defaultLoginConnection: ClientConfig,
  outSrvConfig: OutboxServiceConfig,
  inSrvConfig: InboxServiceConfig,
): Promise<void> => {
  const { host, port, database, user, password } = defaultLoginConnection;
  const rootClient = new Client({
    host,
    port,
    user: 'postgres',
    password: 'postgres',
  });
  rootClient.connect();

  await rootClient.query(/* sql*/ `
      SELECT pg_terminate_backend (pg_stat_activity.pid)
      FROM pg_stat_activity
      WHERE pg_stat_activity.datname = '${database}';
    `);
  await rootClient.query(/* sql*/ `
      DROP DATABASE IF EXISTS ${database};
    `);
  await rootClient.query(/* sql*/ `
      CREATE DATABASE ${database};
    `);
  await rootClient.query(/* sql*/ `
      DROP ROLE IF EXISTS ${outSrvConfig.pgReplicationConfig.user};
      CREATE ROLE ${outSrvConfig.pgReplicationConfig.user} WITH REPLICATION LOGIN PASSWORD '${outSrvConfig.pgReplicationConfig.password}';
    `);

  await rootClient.query(/* sql*/ `
      DROP ROLE IF EXISTS ${inSrvConfig.pgReplicationConfig.user};
      CREATE ROLE ${inSrvConfig.pgReplicationConfig.user} WITH REPLICATION LOGIN PASSWORD '${inSrvConfig.pgReplicationConfig.password}';
    `);
  await rootClient.query(/* sql*/ `
      DROP ROLE IF EXISTS ${user};
      CREATE ROLE ${user} WITH LOGIN PASSWORD '${password}';
      GRANT CONNECT ON DATABASE ${database} TO ${user};
    `);
  rootClient.end();
};

const outboxSetup = async (
  defaultLoginConnection: ClientConfig,
  {
    settings: { dbSchema, dbTable, postgresPub, postgresSlot },
  }: OutboxServiceConfig,
): Promise<void> => {
  const { host, port, database, user } = defaultLoginConnection;
  const dbClient = new Client({
    host,
    port,
    database,
    user: 'postgres',
    password: 'postgres',
  });
  dbClient.connect();

  await dbClient.query(/* sql*/ `
      CREATE SCHEMA IF NOT EXISTS ${dbSchema}
    `);
  await dbClient.query(/* sql*/ `
      DROP TABLE IF EXISTS ${dbSchema}.${dbTable} CASCADE;
      CREATE TABLE ${dbSchema}.${dbTable} (
        id uuid PRIMARY KEY,
        aggregate_type VARCHAR(255) NOT NULL,
        aggregate_id VARCHAR(255) NOT NULL,
        message_type VARCHAR(255) NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      GRANT USAGE ON SCHEMA ${dbSchema} TO ${user} ;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ${dbSchema}.${dbTable} TO ${user};
    `);
  await dbClient.query(/* sql*/ `
      DROP PUBLICATION IF EXISTS ${postgresPub};
      CREATE PUBLICATION ${postgresPub} FOR TABLE ${dbSchema}.${dbTable} WITH (publish = 'insert')
    `);
  await dbClient.query(/* sql*/ `
      select pg_create_logical_replication_slot('${postgresSlot}', 'pgoutput');
    `);
  await dbClient.query(/* sql*/ `
      DROP TABLE IF EXISTS public.source_entities CASCADE;
      CREATE TABLE IF NOT EXISTS public.source_entities (
        id uuid PRIMARY KEY,
        content TEXT NOT NULL
      );
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.source_entities TO ${user};
    `);
  dbClient.end();
};

/** All the changes related to the inbox implementation in the database */
const inboxSetup = async (
  defaultLoginConnection: ClientConfig,
  {
    settings: { dbSchema, dbTable, postgresPub, postgresSlot },
  }: OutboxServiceConfig,
): Promise<void> => {
  const { host, port, database, user } = defaultLoginConnection;
  const dbClient = new Client({
    host,
    port,
    database,
    user: 'postgres',
    password: 'postgres',
  });
  dbClient.connect();

  await dbClient.query(/* sql*/ `
      CREATE SCHEMA IF NOT EXISTS ${dbSchema}
    `);
  await dbClient.query(/* sql*/ `
      DROP TABLE IF EXISTS ${dbSchema}.${dbTable} CASCADE;
      CREATE TABLE ${dbSchema}.${dbTable} (
        id uuid PRIMARY KEY,
        aggregate_type VARCHAR(255) NOT NULL,
        aggregate_id VARCHAR(255) NOT NULL,
        message_type VARCHAR(255) NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        retries smallint NOT NULL DEFAULT 0
      );
      GRANT USAGE ON SCHEMA ${dbSchema} TO ${user} ;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ${dbSchema}.${dbTable} TO ${user};
    `);
  await dbClient.query(/* sql*/ `
      DROP PUBLICATION IF EXISTS ${postgresPub};
      CREATE PUBLICATION ${postgresPub} FOR TABLE ${dbSchema}.${dbTable} WITH (publish = 'insert')
    `);
  await dbClient.query(/* sql*/ `
      select pg_create_logical_replication_slot('${postgresSlot}', 'pgoutput');
    `);
  await dbClient.query(/* sql*/ `
      DROP TABLE IF EXISTS public.received_entities CASCADE;
      CREATE TABLE IF NOT EXISTS public.received_entities (
        id uuid PRIMARY KEY,
        content TEXT NOT NULL
      );
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.received_entities TO ${user};
    `);
  dbClient.end();
};
