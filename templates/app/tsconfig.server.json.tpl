{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "lib": [
      "ESNext"
    ],
    "types": [
      "bun"
    ]
  },
  "include": [
    "scripts/**/*.ts",
    "src/models/**/*.ts",
    "src/routes/**/*.ts",
    "src/requests/**/*.ts",
    "src/web/**/*.ts",
    "src/**/*.test.ts",
    "database/**/*.ts"
  ]
}
