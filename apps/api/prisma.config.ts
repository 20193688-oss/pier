import { defineConfig } from 'prisma/config';

/**
 * The Prisma CLI's configuration (generate, migrate). The service itself reads
 * DATABASE_URL through its validated environment (`src/config/env.ts`); the
 * placeholder only lets `prisma generate` run where no database is configured.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url:
      process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
});
