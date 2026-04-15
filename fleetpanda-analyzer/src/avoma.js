'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

async function fetchAvomaData(avomaUrl) {
  if (!avomaUrl || !avomaUrl.trim()) {
    return { error: 'No Avoma URL provided.' };
  }

  let res;
  try {
    res = await fetch(avomaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 20000,
      redirect: 'follow',
    });
  } catch (err) {
    return { error: `Failed to fetch Avoma URL: ${err.message}` };
  }

  if (res.status === 401 || res.status === 403) {
    return { error: 'Could not access Avoma page — please check the link or your Avoma login.' };
  }

  if (!res.ok) {
    return { error: `Could not access Avoma page — HTTP ${res.status}. Please check the link or your Avoma login.` };
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // Check for auth wall indicators
  const pageText = $('body').text().toLowerCase();
  if (
    pageText.includes('sign in') ||
    pageText.includes('log in') ||
    pageText.includes('login required') ||
    pageText.includes('please sign in') ||
    (pageText.length < 500 && pageText.includes('avoma'))
  ) {
    // Try to still extract anything useful before giving up
    const title = $('title').text().trim();
    if (!title || title.toLowerCase().includes('login') || title.toLowerCase().includes('sign')) {
      return { error: 'Could not access Avoma page — please check the link or your Avoma login.' };
    }
  }

  const result = extractAvomaContent($, html);

  // Save raw output
  const outputPath = path.join(__dirname, '..', 'outputs', 'avoma_raw.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

  return result;
}

function extractAvomaContent($, html) {
  const data = {
    title: '',
    meetingDate: '',
    duration: '',
    participants: [],
    keyMoments: [],
    topics: [],
    actionItems: [],
    speakerHighlights: [],
    objections: [],
    summary: '',
    rawTextSample: '',
  };

  // Title
  data.title = $('h1').first().text().trim() ||
    $('[class*="title"]').first().text().trim() ||
    $('title').text().trim();

  // Meeting meta
  $('[class*="date"], [class*="time"], [class*="duration"]').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length < 100) {
      if (text.match(/\d{1,2}[\/\-]\d{1,2}/) || text.match(/jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i)) {
        data.meetingDate = data.meetingDate || text;
      }
      if (text.match(/\d+\s*(min|hour|hr)/i)) {
        data.duration = data.duration || text;
      }
    }
  });

  // Participants / speakers
  const speakerSelectors = [
    '[class*="speaker"]',
    '[class*="participant"]',
    '[class*="attendee"]',
    '[data-testid*="speaker"]',
  ];
  speakerSelectors.forEach(sel => {
    $(sel).each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length < 100 && !data.participants.includes(text)) {
        data.participants.push(text);
      }
    });
  });
  data.participants = data.participants.slice(0, 20);

  // Key moments
  const momentSelectors = [
    '[class*="moment"]',
    '[class*="highlight"]',
    '[class*="key-point"]',
    '[class*="bookmark"]',
  ];
  momentSelectors.forEach(sel => {
    $(sel).each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 10 && text.length < 500) {
        data.keyMoments.push(text);
      }
    });
  });
  data.keyMoments = [...new Set(data.keyMoments)].slice(0, 20);

  // Topics discussed
  const topicSelectors = [
    '[class*="topic"]',
    '[class*="chapter"]',
    '[class*="section"]',
    '[class*="segment"]',
  ];
  topicSelectors.forEach(sel => {
    $(sel).each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 3 && text.length < 200) {
        data.topics.push(text);
      }
    });
  });
  data.topics = [...new Set(data.topics)].slice(0, 20);

  // Action items
  const actionSelectors = [
    '[class*="action"]',
    '[class*="todo"]',
    '[class*="task"]',
    '[class*="next-step"]',
  ];
  actionSelectors.forEach(sel => {
    $(sel).each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 5 && text.length < 300) {
        data.actionItems.push(text);
      }
    });
  });
  data.actionItems = [...new Set(data.actionItems)].slice(0, 20);

  // Summary blocks
  const summarySelectors = [
    '[class*="summary"]',
    '[class*="overview"]',
    '[class*="recap"]',
    '[class*="brief"]',
  ];
  summarySelectors.forEach(sel => {
    $(sel).each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 50) {
        data.summary += (data.summary ? '\n' : '') + text;
      }
    });
  });
  data.summary = data.summary.slice(0, 3000);

  // Objections
  const objectionKeywords = ['concern', 'objection', 'pushback', 'hesitant', 'worried', 'price', 'cost', 'expensive', 'competitor'];
  $('p, li, [class*="note"], [class*="comment"]').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 20 && text.length < 500) {
      const lower = text.toLowerCase();
      if (objectionKeywords.some(kw => lower.includes(kw))) {
        data.objections.push(text);
      }
    }
  });
  data.objections = [...new Set(data.objections)].slice(0, 15);

  // Raw text sample for context (first 2000 chars of body text, stripped)
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  data.rawTextSample = bodyText.slice(0, 2000);

  return data;
}

module.exports = { fetchAvomaData };
