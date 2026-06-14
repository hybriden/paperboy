// Minimal ESLint pass for the ONE thing oxlint can't do: react-hooks/rules-of-hooks
// (calling hooks conditionally / in loops / outside components — a crash class oxlint
// doesn't implement). oxlint already covers react-hooks/exhaustive-deps and everything
// else, so this config enables rules-of-hooks ONLY — no overlap, no second linter creep.
// Parser-only (no type info) keeps it fast. Run via `pnpm --filter @paperboy/admin lint`.
import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
    },
    // This pass runs ONLY rules-of-hooks. Existing `eslint-disable` comments in
    // the source target exhaustive-deps/no-console (honored by oxlint, which also
    // reads them) — not "unused", just out of this config's scope — so don't
    // report them here or they'd surface as spurious warnings.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "react-hooks/rules-of-hooks": "error",
    },
  },
];
