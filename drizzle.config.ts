import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/main/services/database/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: ':memory:',
  },
});
