import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.next/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', fetch: 'readonly', Request: 'readonly', Response: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' } },
    rules: { '@typescript-eslint/no-explicit-any': 'error' }
  },
  {
    files: ['apps/web/public/service-worker.js'],
    languageOptions: { globals: { self: 'readonly', caches: 'readonly', fetch: 'readonly', URL: 'readonly', Response: 'readonly' } }
  }
);
