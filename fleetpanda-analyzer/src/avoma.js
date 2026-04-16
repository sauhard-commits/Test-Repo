'use strict';

/**
 * Avoma Skill — API-based call fetcher
 *
 * Replaces the old HTML-scraping approach with direct Avoma REST API calls.
 *
 * Strategy:
 *  Run two searches IN PARALLEL and merge results:
 *   1. Title/search search  — meetings whose title contains the company name
 *   2. Attendee email search — one query per contact email from HubSpot deal
 *  Deduplicate by meeting UUID, sort chronologically, fetch full details
 *  for each matched meeting (transcript, notes, action items).
 *
 * Why both?
 *  - Title search works even when HubSpot contacts have no email.
 *  - Email search catches meetings where the title doesn't match the company name.
 *  - Together they cover the broadest set of related calls.
 *
 * Env vars:
 *   AVOMA_API_KEY  — Avoma API key (Settings → Integrations → API)
 *
 * If AVOMA_API_KEY is not set the function returns gracefully with an empty
 * call list so the rest of the pipeline (analysis + docx) still runs on
 * HubSpot data alone.
 */

const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

const AVOMA_BASE = 'https://api.avoma.com/v1';

// ─── API helper ───────────────────────────────────────────────────────────────

async function avomaRequest(endpoint, params = {}) {
  const apiKey = process.env.AVOMA_API_KEY;
  if (!apiKey) throw new Error('AVOMA_API_KEY not set in .env');

  const url = new URL(`${AVOMA_BASE}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
  });

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    timeout: 20000,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Avoma API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Search functions ─────────────────────────────────────────────────────────

/**
 * Search meetings by company name in the meeting title.
 * Uses the `search` param which Avoma matches against title/participants.
 */
async function searchByCompanyName(companyName, fromDate, toDate) {
  try {
    const data = await avomaRequest('/meetings/', {
      search:    companyName,
      from_date: fromDate,
      to_date:   toDate,
      page_size: 50,
    });
    return data.results || [];
  } catch (err) {
    console.warn(`[Avoma] Title search failed: ${err.message}`);
    return [];
  }
}

/**
 * Search meetings where a specific email address was an attendee.
 */
async function searchByEmail(email, fromDate, toDate) {
  try {
    const data = await avomaRequest('/meetings/', {
      attendee_email: email,
      from_date:      fromDate,
      to_date:        toDate,
      page_size:      50,
    });
    return data.results || [];
  } catch (err) {
    console.warn(`[Avoma] Email search for ${email} failed: ${err.message}`);
    return [];
  }
}

// ─── Detail fetcher ───────────────────────────────────────────────────────────

/**
 * Fetch full meeting record including transcript, notes, action items.
 */
async function getMeetingDetail(uuid) {
  try {
    return await avomaRequest(`/meetings/${uuid}/`);
  } catch (err) {
    console.warn(`[Avoma] Could not fetch meeting ${uuid}: ${err.message}`);
    return null;
  }
}

// ─── Formatters ───────────────────────────────────────────────────────────────

/**
 * Format Avoma's transcript array into readable speaker-labeled text.
 * Handles both {speaker, text, start_time} and {speaker_name, content, offset}
 * schemas (Avoma has varied this across API versions).
 */
function formatTranscript(transcript) {
  if (!Array.isArray(transcript) || !transcript.length) return '';

  return transcript
    .map(item => {
      const speaker =
        item.speaker ||
        item.speaker_name ||
        item.speakerName ||
        (item.participant && (item.participant.name || item.participant.email)) ||
        '';

      const text =
        item.text ||
        item.content ||
        item.phrase ||
        '';

      if (!text || !text.trim()) return null;

      // Build timestamp (seconds → MM:SS)
      const rawTime =
        item.start_time !== undefined ? item.start_time :
        item.start      !== undefined ? item.start      :
        item.offset     !== undefined ? item.offset     : null;

      let timeStr = '';
      if (rawTime !== null) {
        const secs = Math.floor(Number(rawTime));
        timeStr = `[${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}] `;
      }

      return `${timeStr}${speaker ? speaker + ': ' : ''}${text.trim()}`;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Classify call type from title + index position.
 */
function classifyCallType(title, index) {
  const t = (title || '').toLowerCase();
  if (t.includes('discovery') || t.includes('intro') || t.includes('initial')) return 'Discovery';
  if (t.includes('demo') || t.includes('walkthrough') || t.includes('demonstration')) return 'Demo';
  if (t.includes('pric') || t.includes('proposal') || t.includes('quote')) return 'Pricing / Proposal';
  if (t.includes('close') || t.includes('decision') || t.includes('final')) return 'Close / Decision';
  if (t.includes('follow') || t.includes('check')) return 'Follow-up';
  if (index === 0) return 'Discovery / First Call';
  return 'Follow-up';
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function fetchAvomaData(companyName, hubspotData) {
  // Graceful exit if no API key — analysis still runs on HubSpot data alone
  if (!process.env.AVOMA_API_KEY) {
    console.warn('[Avoma] AVOMA_API_KEY not set — skipping call data.');
    return {
      note: 'AVOMA_API_KEY not configured. Add it to .env to enable automatic call fetching.',
      totalCalls: 0,
      calls: [],
    };
  }

  // Date range: deal creation date → close date (or today)
  const rawCreate = hubspotData.createDate || hubspotData.allProperties?.createdate;
  const rawClose  = hubspotData.closeDate  || hubspotData.allProperties?.closedate;

  const fromDate = rawCreate
    ? rawCreate.split('T')[0]
    : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const toDate = rawClose
    ? rawClose.split('T')[0]
    : new Date().toISOString().split('T')[0];

  // Collect contact emails from HubSpot associations
  const contacts =
    hubspotData.contacts ||
    (hubspotData.associations && hubspotData.associations.contacts) ||
    [];

  const emails = contacts
    .map(c => c.email)
    .filter(Boolean);

  console.log(`[Avoma] Searching for "${companyName}" | ${fromDate} → ${toDate} | ${emails.length} contact email(s)`);

  // ── Dual search — parallel ─────────────────────────────────────────────────
  const searches = [
    searchByCompanyName(companyName, fromDate, toDate),
    ...emails.map(email => searchByEmail(email, fromDate, toDate)),
  ];

  const searchResults = await Promise.all(searches);

  // Merge + deduplicate by UUID
  const seen = new Set();
  const merged = searchResults
    .flat()
    .filter(m => {
      if (!m.uuid || seen.has(m.uuid)) return false;
      seen.add(m.uuid);
      return true;
    })
    .sort((a, b) => {
      const da = new Date(a.created_at || a.date || 0);
      const db = new Date(b.created_at || b.date || 0);
      return da - db;
    });

  console.log(`[Avoma] Found ${merged.length} unique meeting(s) after dedup`);

  if (!merged.length) {
    const result = {
      note: `No Avoma meetings found for "${companyName}" between ${fromDate} and ${toDate}. Check company name spelling or expand the date range.`,
      totalCalls: 0,
      searchedBy: { companyName, emails, fromDate, toDate },
      calls: [],
    };
    const outputPath = path.join(__dirname, '..', 'outputs', 'avoma_raw.json');
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    return result;
  }

  // ── Fetch full details for every matched meeting ───────────────────────────
  const details = await Promise.all(merged.map(m => getMeetingDetail(m.uuid)));

  const calls = details
    .filter(Boolean)
    .map((meeting, i) => {
      // Notes can live in meeting.notes (object) or meeting.summary (string)
      const notes     = meeting.notes || {};
      const summary   = notes.summary || meeting.summary || notes.overview || '';
      const keyPoints = notes.key_points || notes.keyPoints || notes.highlights || meeting.highlights || [];
      const actionItems = (notes.action_items || notes.actionItems || meeting.action_items || [])
        .map(a => (typeof a === 'string' ? a : a.text || a.content || JSON.stringify(a)))
        .filter(Boolean);

      const participants = (meeting.participants || [])
        .map(p => p.name || p.full_name || p.email || '')
        .filter(Boolean);

      const fullTranscript = formatTranscript(
        meeting.transcript || meeting.transcription || [],
      );

      return {
        callNumber:     i + 1,
        callLabel:      `Call ${i + 1}`,
        callType:       classifyCallType(meeting.title, i),
        uuid:           meeting.uuid,
        title:          meeting.title || '',
        date:           meeting.created_at || meeting.date || '',
        durationSeconds:meeting.duration || null,
        participants,
        fullTranscript,
        summary,
        keyPoints: Array.isArray(keyPoints) ? keyPoints.slice(0, 30) : [],
        actionItems,
        topics:    meeting.topics || [],
      };
    });

  const combined = {
    totalCalls:       calls.length,
    searchedBy:       { companyName, emails, fromDate, toDate },
    calls,
  };

  const outputPath = path.join(__dirname, '..', 'outputs', 'avoma_raw.json');
  fs.writeFileSync(outputPath, JSON.stringify(combined, null, 2));

  return combined;
}

module.exports = { fetchAvomaData };
