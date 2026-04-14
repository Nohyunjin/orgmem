import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/storage/schema.ts",
  out: "./src/storage/migrations",
  dialect: "sqlite",
  // For migration generation only — runtime DB path comes from ORGMEM_DB env
  // or the CLI's default (see src/storage/sqlite.ts).
  dbCredentials: {
    url: process.env.ORGMEM_DB ?? ".orgmem/dev.db",
  },
  strict: true,
  verbose: true,
});
