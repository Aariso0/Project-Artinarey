import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['apps/gui/src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
);
