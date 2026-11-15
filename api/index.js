let appInstance = null;
let bootError = null;

try {
  const { app } = require('../server');
  appInstance = app;
} catch (err) {
  bootError = err;
  console.error('[Vercel Boot Error] Critical failure loading server.js:', err);
}

module.exports = (req, res) => {
  if (bootError) {
    console.error('[Vercel Request Error] Handled request while bootError exists:', bootError);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(
      JSON.stringify(
        {
          error: 'Vercel Serverless Function Boot Error',
          message: bootError.message,
          stack: bootError.stack
        },
        null,
        2
      )
    );
  }

  return appInstance(req, res);
};
