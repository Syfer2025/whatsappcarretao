const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'media/**',
      '.wwebjs_auth/**',
      '.wwebjs_cache/**',
      'data.db*',
      'server.log',
      'coverage/**'
    ]
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error'
    }
  }
];
