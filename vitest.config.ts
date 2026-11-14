import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, 'tests/obsidian-fakes.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Timestamps are converted to the device's local time, so pin the zone:
    // without this, results depend on the machine running the suite. Tests
    // about a particular zone set process.env.TZ themselves.
    env: { TZ: 'UTC' },
  },
});
