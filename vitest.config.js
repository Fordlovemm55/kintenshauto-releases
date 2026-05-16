import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: [
        'src/backend/core/**/*.js',
        'src/backend/local/**/*.js',
        'src/backend/cloud/**/*.js',
        'src/backend/services/**/*.js'
      ],
      exclude: ['**/node_modules/**', 'tests/**'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: {
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0
      }
    },
    testTimeout: 10000
  }
});
