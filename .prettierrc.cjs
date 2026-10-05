/** @type {import('prettier').Config} */
module.exports = {
  printWidth: 100,
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  arrowParens: 'always',
  endOfLine: 'lf',
  overrides: [
    {
      files: ['*.md', '*.yaml', '*.yml'],
      options: { proseWrap: 'preserve' },
    },
  ],
};
