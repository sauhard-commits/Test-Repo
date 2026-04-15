'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');

const { fetchHubSpotData } = require('./src/hubspot');
const { fetchAvomaData } = require('./src/avoma');
const { analyzeDeal } = require('./src/analyze');
const { generateDocx } = require('./src/docx_writer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Server-Sent Events — progress map keyed by requestId
const progressClients = new Map();

function sendProgress(requestId, step, message) {
  const res = progressClients.get(requestId);
  if (res) {
    res.write(`data: ${JSON.stringify({ step, message })}\n\n`);
  }
}

// SSE endpoint for progress updates
app.get('/progress/:requestId', (req, res) => {
  const { requestId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  progressClients.set(requestId, res);

  req.on('close', () => {
    progressClients.delete(requestId);
  });
});

// POST /analyze
app.post('/analyze', async (req, res) => {
  const { dealName, avomaUrl, requestId } = req.body;

  if (!dealName || !dealName.trim()) {
    return res.status(400).json({ error: 'dealName is required' });
  }

  try {
    // Step 1 & 2 — run HubSpot + Avoma in parallel
    sendProgress(requestId, 1, 'Pulling HubSpot data...');
    sendProgress(requestId, 2, 'Reading Avoma call summary...');

    const [hubspotData, avomaData] = await Promise.all([
      fetchHubSpotData(dealName.trim()),
      fetchAvomaData(avomaUrl ? avomaUrl.trim() : ''),
    ]);

    sendProgress(requestId, 1, 'HubSpot data retrieved.');
    sendProgress(requestId, 2, 'Avoma data retrieved.');

    // Step 3 — analyze
    sendProgress(requestId, 3, 'Running win/loss analysis...');
    const debrief = await analyzeDeal(hubspotData, avomaData);
    sendProgress(requestId, 3, 'Analysis complete.');

    // Step 4 — generate docx
    sendProgress(requestId, 4, 'Building Word doc...');
    const { filename, outputPath } = await generateDocx(debrief, dealName.trim());
    sendProgress(requestId, 4, `Word doc ready: ${filename}`);

    // Close SSE stream
    const sseRes = progressClients.get(requestId);
    if (sseRes) {
      sseRes.write(`data: ${JSON.stringify({ step: 'done', filename })}\n\n`);
      sseRes.end();
      progressClients.delete(requestId);
    }

    return res.json({ debrief, filename });
  } catch (err) {
    console.error('Analysis error:', err);

    const sseRes = progressClients.get(requestId);
    if (sseRes) {
      sseRes.write(`data: ${JSON.stringify({ step: 'error', message: err.message })}\n\n`);
      sseRes.end();
      progressClients.delete(requestId);
    }

    return res.status(500).json({ error: err.message });
  }
});

// POST /download
app.post('/download', async (req, res) => {
  const { debrief, companyName } = req.body;

  if (!debrief) {
    return res.status(400).json({ error: 'debrief is required' });
  }

  try {
    const { filename, outputPath } = await generateDocx(debrief, companyName || 'Company');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const buffer = fs.readFileSync(outputPath);
    return res.send(buffer);
  } catch (err) {
    console.error('Download error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Ensure outputs directory exists
const outputsDir = path.join(__dirname, 'outputs');
if (!fs.existsSync(outputsDir)) {
  fs.mkdirSync(outputsDir, { recursive: true });
}

app.listen(PORT, () => {
  console.log(`FleetPanda Analyzer running at http://localhost:${PORT}`);
});
