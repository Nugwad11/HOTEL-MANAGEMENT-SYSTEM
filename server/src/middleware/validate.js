/**
 * validate(schema) — Zod schema validation middleware.
 * Validates req.body and attaches the parsed result as req.data.
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const messages = result.error.errors.map((e) => e.message);
      return res.status(422).json({ error: messages[0], details: messages });
    }
    req.data = result.data;
    next();
  };
}

module.exports = { validate };
