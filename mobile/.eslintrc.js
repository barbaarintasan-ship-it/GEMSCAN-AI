// https://docs.expo.dev/guides/using-eslint/
module.exports = {
  extends: 'expo',
  overrides: [
    {
      // Plain CommonJS/Node tooling scripts, not app/bundle code.
      files: ['scripts/**/*.js'],
      env: { node: true },
    },
  ],
};
