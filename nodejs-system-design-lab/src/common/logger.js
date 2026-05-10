const LEVELS = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

const activeLevel = LEVELS[(process.env.LOG_LEVEL || "INFO").toUpperCase()] || LEVELS.INFO;

function normalizeValue(value) {
  if (value instanceof Error) {
    // Preserve useful debugging fields while keeping production logs from leaking full stacks.
    return {
      name: value.name,
      message: value.message,
      code: value.code,
      stack: process.env.NODE_ENV === "production" ? undefined : value.stack,
    };
  }
  return value;
}

function sanitizeContext(context = {}) {
  const out = {};
  for (const [key, value] of Object.entries(context || {})) {
    if (value !== undefined) {
      out[key] = normalizeValue(value);
    }
  }
  return out;
}

function formatLog(level, message, context = {}) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: "nodejs-system-design-lab",
    message,
    ...sanitizeContext(context),
  });
}

function write(level, message, context) {
  if (LEVELS[level] < activeLevel) {
    return;
  }
  const line = formatLog(level, message, context);
  if (level === "ERROR") {
    console.error(line);
  } else if (level === "WARN") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function createLogger(defaultContext = {}) {
  return {
    child(context = {}) {
      // Child loggers attach stable context such as requestId without passing it through every call.
      return createLogger({ ...defaultContext, ...context });
    },
    debug(message, context = {}) {
      write("DEBUG", message, { ...defaultContext, ...context });
    },
    info(message, context = {}) {
      write("INFO", message, { ...defaultContext, ...context });
    },
    warn(message, context = {}) {
      write("WARN", message, { ...defaultContext, ...context });
    },
    error(message, context = {}) {
      write("ERROR", message, { ...defaultContext, ...context });
    },
  };
}

const logger = createLogger();

module.exports = { logger, createLogger, formatLog };
