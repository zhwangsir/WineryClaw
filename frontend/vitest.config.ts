import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      exclude: [
        'node_modules/',
        'src/**/*.test.{ts,tsx}',
        'src/test-setup.ts',
        'src/**/*.d.ts',
      ],
      thresholds: {
        lines: 50,
        functions: 40,
        branches: 65,
        statements: 50,
      },
    },
  },
});
