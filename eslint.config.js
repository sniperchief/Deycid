// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    files: ['src/utils/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
