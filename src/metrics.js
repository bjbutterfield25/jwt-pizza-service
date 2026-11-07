const config = require('./config.js');

// Metrics stored in memory
const requests = {};

const methodTotals = {
  total: 0,
  GET: 0,
  POST: 0,
  PUT: 0,
  DELETE: 0,
};

// Middleware to track requests
function requestTracker(req, res, next) {
  const endpoint = `[${req.method}] ${req.path}`;
  requests[endpoint] = (requests[endpoint] || 0) + 1;

  methodTotals.total += 1;
  if (Object.prototype.hasOwnProperty.call(methodTotals, req.method)) {
    methodTotals[req.method] += 1;
  }

  next();
}

function createMetric(metricName, metricValue, metricUnit, metricType, valueType, attributes = {}) {
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
    metric[metricType].isMonotonic = true;
  }

  return metric;
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

  fetch(endpointUrl, {
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
    })
    .catch((error) => {
      console.error('Error pushing metrics:', error);
    });
}

function collectMetrics() {
  const metrics = [];

  Object.keys(requests).forEach((endpoint) => {
    metrics.push(createMetric('requests', requests[endpoint], '1', 'sum', 'asInt', { endpoint }));
  });

  metrics.push(createMetric('http_requests_total', methodTotals.total, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('http_requests_get_total', methodTotals.GET, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('http_requests_post_total', methodTotals.POST, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('http_requests_put_total', methodTotals.PUT, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('http_requests_delete_total', methodTotals.DELETE, '1', 'sum', 'asInt', {}));

  sendMetricToGrafana(metrics);
}

function startMetrics(intervalMs = 10000) {
  const timer = setInterval(collectMetrics, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  requestTracker,
  createMetric,
  sendMetricToGrafana,
  collectMetrics,
  startMetrics,
  requests,
  methodTotals,
};
