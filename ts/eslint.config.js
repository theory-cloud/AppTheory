import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";
import importPlugin from "eslint-plugin-import-x";
import promise from "eslint-plugin-promise";
import unicorn from "eslint-plugin-unicorn";
import prettier from "eslint-config-prettier";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

export default [
  js.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir,
      },
      globals: {
        ...globals.node,
        fetch: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "import-x": importPlugin,
      promise,
      unicorn,
    },
    settings: {
      "import-x/resolver": {
        node: true,
      },
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      // @eslint/js 10 added these three to `recommended`. They report on sources
      // this dependency-only bump does not touch, so adopting them would be a
      // reviewed lint-policy change; hold the eslint 9 reviewed surface instead.
      "no-unassigned-vars": "off",
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "error",
      "no-nested-ternary": "error",
      curly: ["error", "all"],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-implicit-coercion": "error",
      "no-warning-comments": ["error", { terms: ["todo", "fixme", "xxx"], location: "start" }],
      "object-shorthand": "error",
      "prefer-const": "error",
      "prefer-template": "error",

      "import-x/extensions": ["error", "always", { ignorePackages: true }],
      "import-x/first": "error",
      "import-x/no-duplicates": "error",
      "import-x/no-unresolved": "off",
      "import-x/order": [
        "error",
        {
          alphabetize: { order: "asc", caseInsensitive: true },
          "newlines-between": "always",
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
        },
      ],

      "promise/catch-or-return": "error",
      "promise/no-return-wrap": "error",
      "promise/param-names": "error",

      "unicorn/prefer-node-protocol": "error",
    },
  },
  prettier,
];
