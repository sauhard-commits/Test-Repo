'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const { fetchHubSpotData } = require('./src/hubspot');
const { fetchAvomaData }   = require('./src/avoma');
const { analyzeDeal }      = require('./src/analyze');
const { generateDocx }     = require('./src/docx_writer');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Server-Sent Events ───────────────────────────────────────────────────────

const progressClients = new Map();

function sendProgress(requestId, step, message) {
  const res = progressClients.get(requestId);
  if (res) res.write(`data: ${JSON.stringify({ step, message })}\n\n`);
}

function closeSSE(requestId, payload) {
  const res = progressClients.get(requestId);
  if (res) {
    res.write(`data: ${JSON.stringify({ step: 'done', ...payload })}\n\n`);
    res.end();
    progressClients.delete(requestId);
  }
}

function errorSSE(requestId, message) {
  const res = progressClients.get(requestId);
  if (res) {
    res.write(`data: ${JSON.stringify({ step: 'error', message })}\n\n`);
    res.end();
    progressClients.delete(requestId);
  }
}

app.get('/progress/:requestId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  progressClients.set(req.params.requestId, res);
  req.on('close', () => progressClients.delete(req.params.requestId));
});

// ─── POST /analyze ────────────────────────────────────────────────────────────
//
// Body: { dealName: string, requestId: string }
//
// Pipeline (sequential — Avoma needs HubSpot contact emails):
//   Step 1 — HubSpot: pull deal data + contact emails
//   Step 2 — Avoma:   search by company name AND contact emails, fetch transcripts
//   Step 3 — Analyze: Grok win/loss analysis
//   Step 4 — DOCX:    generate Word document
//
app.post('/analyze', async (req, res) => {
  const { dealName, requestId } = req.body;

  if (!dealName || !dealName.trim()) {
    return res.status(400).json({ error: 'dealName is required' });
  }

  try {
    // Step 1 — HubSpot
    sendProgress(requestId, 1, 'Pulling HubSpot deal data...');
    const hubspotData = await fetchHubSpotData(dealName.trim());
    sendProgress(requestId, 1, 'HubSpot data retrieved.');

    // Step 2 — Avoma (uses HubSpot contact emails for email search)
    sendProgress(requestId, 2, `Searching Avoma for calls related to "${dealName.trim()}"...`);
    const avomaData = await fetchAvomaData(dealName.trim(), hubspotData);
    const callCount = (avomaData.calls || []).length;
    sendProgress(
      requestId,
      2,
      callCount
        ? `Found ${callCount} Avoma call${callCount === 1 ? '' : 's'}.`
        : (avomaData.note || 'No Avoma calls found — analysis will use HubSpot data only.'),
    );

    // Step 3 — Analysis
    sendProgress(requestId, 3, 'Running win/loss analysis...');
    const debrief = await analyzeDeal(hubspotData, avomaData);
    sendProgress(requestId, 3, 'Analysis complete.');

    // Step 4 — DOCX
    sendProgress(requestId, 4, 'Building Word doc...');
    const { filename } = await generateDocx(debrief, dealName.trim());
    sendProgress(requestId, 4, `Word doc ready: ${filename}`);

    closeSSE(requestId, { filename });
    return res.json({ debrief, filename });

  } catch (err) {
    console.error('Analysis error:', err);
    errorSSE(requestId, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /download ───────────────────────────────────────────────────────────

app.post('/download', async (req, res) => {
  const { debrief, companyName } = req.body;
  if (!debrief) return res.status(400).json({ error: 'debrief is required' });

  try {
    const { filename, outputPath } = await generateDocx(debrief, companyName || 'Company');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(fs.readFileSync(outputPath));
  } catch (err) {
    console.error('Download error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

const outputsDir = path.join(__dirname, 'outputs');
if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });

app.listen(PORT, () => {
  console.log(`\nFleetPanda Win/Loss Analyzer`);
  console.log(`Running at http://localhost:${PORT}`);
  console.log(`\nRequired env vars:`);
  console.log(`  HUBSPOT_API_KEY  — HubSpot private app token`);
  console.log(`  XAI_API_KEY      — xAI / Grok API key`);
  console.log(`  AVOMA_API_KEY    — Avoma API key (Settings → Integrations → API)`);
  console.log(`  GROK_MODEL       — (optional) default: grok-3\n`);
});
