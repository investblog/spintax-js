// Stub — see package.json. Throws on any real use so an accidental dependency
// on isolated-vm surfaces loudly instead of silently doing nothing.
module.exports = new Proxy(
  {},
  {
    get() {
      throw new Error(
        'isolated-vm is stubbed out in this repo (see stubs/isolated-vm); n8n expression evaluation is not available at dev/test time',
      );
    },
  },
);
