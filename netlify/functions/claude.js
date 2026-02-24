const https = require('https');

// In-memory rate limiter: 5 requests per IP per hour
const ipRequests = new Map();
const RATE_LIMIT = 9999; // TEMP: disabled for testing
const WINDOW_MS = 60 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  let timestamps = ipRequests.get(ip) || [];
  timestamps = timestamps.filter(t => now - t < WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT) {
    const resetIn = Math.ceil((timestamps[0] + WINDOW_MS - now) / 60000);
    return { allowed: false, resetIn };
  }
  timestamps.push(now);
  ipRequests.set(ip, timestamps);
  return { allowed: true, remaining: RATE_LIMIT - timestamps.length };
}

function httpsPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || event.headers['client-ip']
    || 'unknown';

  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({
        error: `Rate limit exceeded. Try again in ${rl.resetIn} minute${rl.resetIn !== 1 ? 's' : ''}.`
      }),
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured on server.' }) };
  }

  try {
    const bodyStr = event.body;
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const response = await httpsPost(options, bodyStr);
    const data = JSON.parse(response.body);

    if (response.statusCode !== 200) {
      return {
        statusCode: response.statusCode,
        headers,
        body: JSON.stringify({ error: data?.error?.message || 'Anthropic API error' }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...headers, 'X-RateLimit-Remaining': String(rl.remaining) },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Proxy request failed: ' + err.message }) };
  }
};
