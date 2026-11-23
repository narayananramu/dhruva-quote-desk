import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    testTimeout: 180_000, // Temporal time-skipping tests run in about 10 s alone; a busy laptop can take several times that
    hookTimeout: 180_000,
  },
});
