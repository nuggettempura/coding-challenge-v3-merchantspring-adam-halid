// eslint-disable-next-line
const path = require("path");

module.exports = {
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    project: path.join(__dirname, "tsconfig.json"),
  },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:prettier/recommended",
  ],
  plugins: ["@typescript-eslint", "prettier"],
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  rules: {
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "prettier/prettier": "error",
  },
  overrides: [
    {
      files: ["*.js"],
      parserOptions: { project: null },
    },
    {
      files: ["tests/**/*.ts"],
      parserOptions: { project: null },
    },
  ],
};
