// eslint.config.mjs
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: [
      "tests/**",
      "**/*.test.*",
      "**/*.spec.*",
      "dist/**",
      ".git/**",
      ".vscode/**",
      "Plan/**",
      "node_modules/**",
      "vitest.config.ts",
      "script/**",
      "z_errors_to_fix",
      ".DS_Store",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.eslint.json" },
    },

    // You can add your own configuration to override or add rules
    rules: {
      // example: turn off a rule from the recommended set
      "obsidianmd/sample-names": "off",
      // example: add a rule not in the recommended set and set its severity
      "obsidianmd/prefer-file-manager-trash-file": "error",
      // Sentence case, but the rule cannot know this plugin's own nouns: the
      // product name, the service it talks to, the plan tier the copy names,
      // and the acronyms the settings copy uses.
      "obsidianmd/ui/sentence-case": [
        "error",
        {
          brands: ["Email2Obsidian", "Email2Obsidian.com", "Obsidian", "Pro"],
          acronyms: ["API", "URL", "PDF"],
        },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.jsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.eslint.json" },
    },
  },
]);
