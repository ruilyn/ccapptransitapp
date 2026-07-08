const path = require('path');
const express = require('express');
const cors = require('cors');
const { getLiveStatus } = require('./mta');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Simple in-memory rate limiting-friendly cache is handled inside mta.js;
// here we just serve the aggregated status and never crash the process on
// upstream failures.
app.get('/api/status', async (req, res) => {
  try {
    const status = await getLiveStatus();
    res.json({ ok: true, routes: status, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'Unable to fetch live MTA data.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Route Guardian server listening on http://localhost:${PORT}`);
});
