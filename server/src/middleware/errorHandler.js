/**
 * Central error handler — must be the last app.use().
 * Never leaks stack traces in production.
 */
function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const prod   = process.env.NODE_ENV === "production";
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`, err.message);
  res.status(status).json({
    error:   err.message || "An unexpected error occurred.",
    ...(prod ? {} : { stack: err.stack }),
  });
}

module.exports = errorHandler;
