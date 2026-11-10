const os = require('os');
const config = require('./config.js');

// Metrics stored in memory
const requests = {};
const activeUsers = new Map();
const ACTIVE_USER_WINDOW_MS = 15 * 60 * 1000;

const methodTotals = {
  total: 0,
  GET: 0,
  POST: 0,
  PUT: 0,
  DELETE: 0,
};

const authenticationTotals = {
  success: 0,
  failure: 0,
};

const orderTotals = {
  pizzasSold: 0,
  creationFailures: 0,
  pizzasFailedCreation: 0,
  revenue: 0,
};

const requestLatency = createLatencyTotals();
const pizzaCreationLatency = createLatencyTotals();
const pendingEndpointLatency = [];
const pendingPizzaLatency = [];
let metricsSending = false;
let lastLatencyTimestamp = 0n;

function getCpuLoadPercentage() {
  return (os.loadavg()[0] / os.cpus().length) * 100;
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  return ((totalMemory - freeMemory) / totalMemory) * 100;
}

function createLatencyTotals() {
  return {
    count: 0,
    totalSeconds: 0,
  };
}

function recordLatency(totals, durationSeconds, pendingSamples, attributes = {}) {
  totals.count += 1;
  totals.totalSeconds += durationSeconds;
  const now = BigInt(Date.now()) * 1000000n;
  lastLatencyTimestamp = now > lastLatencyTimestamp ? now : lastLatencyTimestamp + 1n;
  pendingSamples.push({
    value: durationSeconds,
    timeUnixNano: String(lastLatencyTimestamp),
    attributes,
  });
}

function recordSuccessfulOrder(items) {
  orderTotals.pizzasSold += items.length;
  orderTotals.revenue += items.reduce((total, item) => total + Number(item.price || 0), 0);
}

function recordOrderCreationFailure(pizzaCount = 0) {
  orderTotals.creationFailures += 1;
  orderTotals.pizzasFailedCreation += pizzaCount;
}

function recordPizzaCreationDuration(durationSeconds) {
  recordLatency(pizzaCreationLatency, durationSeconds, pendingPizzaLatency);
}

function userLoggedIn(userId) {
  activeUsers.set(String(userId), Date.now());
}

function userLoggedOut(userId) {
  activeUsers.delete(String(userId));
}

function userActivity(userId) {
  if (userId != null) {
    activeUsers.set(String(userId), Date.now());
  }
}

function getActiveUserCount() {
  const cutoff = Date.now() - ACTIVE_USER_WINDOW_MS;
  for (const [userId, lastActivity] of activeUsers) {
    if (lastActivity < cutoff) activeUsers.delete(userId);
  }
  return activeUsers.size;
}

// Middleware to track requests
function requestTracker(req, res, next) {
  const endpoint = `[${req.method}] ${req.path}`;
  requests[endpoint] = (requests[endpoint] || 0) + 1;
  const startedAt = process.hrtime.bigint();

  res.once('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    recordLatency(requestLatency, durationSeconds, pendingEndpointLatency);
  });

  methodTotals.total += 1;
  if (Object.prototype.hasOwnProperty.call(methodTotals, req.method)) {
    methodTotals[req.method] += 1;
  }

  if (req.user?.id != null) {
    userActivity(req.user.id);
  }

  next();
}

function createMetric(metricName, metricValue, metricUnit, metricType, valueType, attributes = {}, isMonotonic = true) {
  const source = config.metrics?.source ?? config.source;
  const metricAttributes = { ...attributes, source };

  const metric = {
    name: metricName,
    unit: metricUnit,
    [metricType]: {
      dataPoints: [{
        [valueType]: metricValue,
        timeUnixNano: String(Date.now() * 1000000),
        attributes: [],
      }],
    },
  };

  Object.keys(metricAttributes).forEach((key) => {
    metric[metricType].dataPoints[0].attributes.push({
      key,
      value: { stringValue: String(metricAttributes[key]) },
    });
  });

  if (metricType === 'sum') {
    metric[metricType].aggregationTemporality = 2;
    metric[metricType].isMonotonic = isMonotonic;
  }

  return metric;
}

function createLatencyGauge(metricName, samples) {
  const source = config.metrics?.source ?? config.source;
  return {
    name: metricName,
    unit: 's',
    gauge: {
      dataPoints: samples.map((sample) => ({
        asDouble: sample.value,
        timeUnixNano: sample.timeUnixNano,
        attributes: Object.entries({ ...sample.attributes, source }).map(([key, value]) => ({
          key,
          value: { stringValue: String(value) },
        })),
      })),
    },
  };
}

// Send metrics to Grafana
function sendMetricToGrafana(metrics) {
  const body = {
    resourceMetrics: [{
      scopeMetrics: [{ metrics }],
    }],
  };

  const endpointUrl = config.metrics?.endpointUrl ?? config.endpointUrl;
  const accountId = config.metrics?.accountId ?? config.accountId;
  const apiKey = config.metrics?.apiKey ?? config.apiKey;

  return fetch(endpointUrl, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${accountId}:${apiKey}`,
      'Content-Type': 'application/json',
    },
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP status: ${response.status}`);
      }
      return true;
    })
    .catch((error) => {
      console.error('Error pushing metrics:', error);
      return false;
    });
}

function collectMetrics() {
  if (metricsSending) return;
  metricsSending = true;

  const metrics = [];
  const endpointSampleCount = pendingEndpointLatency.length;
  const pizzaSampleCount = pendingPizzaLatency.length;

  Object.keys(requests).forEach((endpoint) => {
    metrics.push(createMetric('requests', requests[endpoint], '1', 'sum', 'asInt', { endpoint }));
  });

  metrics.push(createMetric('http_requests_total', methodTotals.total, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('http_requests_get_total', methodTotals.GET, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('http_requests_post_total', methodTotals.POST, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('http_requests_put_total', methodTotals.PUT, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('http_requests_delete_total', methodTotals.DELETE, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('active_users', getActiveUserCount(), '1', 'sum', 'asInt', {}, false));
  metrics.push(createMetric('authentication_success_total', authenticationTotals.success, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('authentication_failure_total', authenticationTotals.failure, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('pizzas_sold_total', orderTotals.pizzasSold, '{pizza}', 'sum', 'asInt', {}));
  metrics.push(createMetric('pizza_creation_failures_total', orderTotals.creationFailures, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('pizzas_failed_creation_total', orderTotals.pizzasFailedCreation, '{pizza}', 'sum', 'asInt', {}));
  metrics.push(createMetric('revenue_total', orderTotals.revenue, 'BTC', 'sum', 'asDouble', {}));
  metrics.push(createMetric('system_cpu_load_percent', getCpuLoadPercentage(), '%', 'gauge', 'asDouble', {}));
  metrics.push(createMetric('system_memory_usage_percent', getMemoryUsagePercentage(), '%', 'gauge', 'asDouble', {}));
  if (endpointSampleCount) {
    metrics.push(createLatencyGauge('http_server_request_duration_seconds', pendingEndpointLatency.slice(0, endpointSampleCount)));
  }
  if (pizzaSampleCount) {
    metrics.push(createLatencyGauge('pizza_creation_duration_seconds', pendingPizzaLatency.slice(0, pizzaSampleCount)));
  }

  return sendMetricToGrafana(metrics)
    .then((sent) => {
      if (sent) {
        pendingEndpointLatency.splice(0, endpointSampleCount);
        pendingPizzaLatency.splice(0, pizzaSampleCount);
      }
    })
    .finally(() => {
      metricsSending = false;
    });
}

function startMetrics(intervalMs = 10000) {
  const timer = setInterval(collectMetrics, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function authenticationSucceeded() {
  authenticationTotals.success += 1;
}

function authenticationFailed() {
  authenticationTotals.failure += 1;
}

module.exports = {
  requestTracker,
  createMetric,
  getCpuLoadPercentage,
  getMemoryUsagePercentage,
  sendMetricToGrafana,
  collectMetrics,
  startMetrics,
  requests,
  methodTotals,
  userLoggedIn,
  userLoggedOut,
  userActivity,
  getActiveUserCount,
  authenticationTotals,
  authenticationSucceeded,
  authenticationFailed,
  orderTotals,
  recordSuccessfulOrder,
  recordOrderCreationFailure,
  requestLatency,
  pizzaCreationLatency,
  recordPizzaCreationDuration,
};
