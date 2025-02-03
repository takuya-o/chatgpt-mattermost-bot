// @ts-check
// from https://typescript-eslint.io/getting-started/

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config({
  files: ['**/*.ts'],
  ignores: ['**/node_modules/**', '**/dist/**'],
  extends: [
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    eslintConfigPrettier,
  ],
  rules: {
    "max-lines-per-function": ["warn", {"max": 75}],  //GitLab25
    "max-lines": ["warn", {"max": 500}], //GitLab250
    //"complexity": ["error", { "max": 5 }], //GitLab5
    "import/order": "off",
    "sort-imports": "warn",
    "@typescript-eslint/no-non-null-assertion": "off",
    /** 命名規則 */
    "@typescript-eslint/naming-convention": [
      "error",
      { // classやtypeなどは頭大文字
        "selector": "typeLike",
        "format": ["PascalCase"]
      },
      { // グローバル定数はアッパーケース
        "selector": "variable",
        "modifiers": ["global", "const"],
        "format": ["camelCase", "UPPER_CASE"]
      },
      { // 変数名はキャメルケース
        "selector": "variable",
        "format": ["camelCase", "UPPER_CASE"]
      }
    ],
    // 未使用の変数や関数は宣言禁止、ただし大文字で始まっているものはクラスなので許す
    "@typescript-eslint/no-unused-vars": ["error", {
      "argsIgnorePattern": "^_",
      "caughtErrorsIgnorePattern": "^_",
      "varsIgnorePattern": "^[A-Z]"
    }],
    "no-unused-vars": ["error", {
      "argsIgnorePattern": "^_",
      "caughtErrorsIgnorePattern": "^_",
      "varsIgnorePattern": "^[A-Z]"
    }],
    "no-console": "error"
  },
});
