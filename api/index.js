const { createAppServer } = require("../server");

// Singleton app instance — reused across warm invocations within the same Lambda.
// State is in-memory and resets on cold start, which is acceptable for a demo.
let _app = null;
const _initPromise = createAppServer({ startSchedulers: false }).then((app) => {
  _app = app;
});

module.exports = async (req, res) => {
  await _initPromise;
  return _app.handler(req, res);
};
