'use strict';

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  BorderStyle,
  convertInchesToTwip,
  LevelFormat,
  AbstractNumbering,
  Numbering,
  NumberingType,
} = require('docx');
const fs = require('fs');
const path = require('path');

// US Letter dimensions in DXA (twips): 12240 x 15840
const PAGE_WIDTH_DXA = 12240;
const PAGE_HEIGHT_DXA = 15840;
const MARGIN_DXA = 1440; // 1 inch

// Colors
const GRAY_BG = 'D9D9D9';
const AMBER = 'C8A84B';
const WHITE = 'FFFFFF';

function safeStr(val) {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) return val.join(', ');
  return String(val);
}

function makeNumberingConfig() {
  return {
    config: [
      {
        reference: 'bullet-list',
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: '\u2022',
            alignment: AlignmentType.LEFT,
            style: {
              paragraph: {
                indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) },
              },
            },
          },
        ],
      },
      {
        reference: 'number-list',
        levels: [
          {
            level: 0,
            format: LevelFormat.DECIMAL,
            text: '%1.',
            alignment: AlignmentType.LEFT,
            style: {
              paragraph: {
                indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) },
              },
            },
          },
        ],
      },
    ],
  };
}

function bulletPara(text) {
  return new Paragraph({
    numbering: { reference: 'bullet-list', level: 0 },
    children: [new TextRun({ text: safeStr(text), font: 'Arial', size: 20 })],
    spacing: { after: 60 },
  });
}

function numberedPara(text, num) {
  return new Paragraph({
    numbering: { reference: 'number-list', level: 0 },
    children: [new TextRun({ text: safeStr(text), font: 'Arial', size: 20 })],
    spacing: { after: 60 },
  });
}

function heading1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text, font: 'Arial', size: 32, bold: true })],
    spacing: { before: 240, after: 120 },
  });
}

function heading2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text, font: 'Arial', size: 26, bold: true })],
    spacing: { before: 240, after: 120 },
  });
}

function heading3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    children: [new TextRun({ text, font: 'Arial', size: 22, bold: true })],
    spacing: { before: 180, after: 80 },
  });
}

function bodyPara(text) {
  return new Paragraph({
    children: [new TextRun({ text: safeStr(text), font: 'Arial', size: 20 })],
    spacing: { after: 80 },
  });
}

function quotePara(quote) {
  const text = safeStr(quote.text);
  const meta = [quote.speaker, quote.timestamp, quote.type].filter(Boolean).join(' | ');
  const children = [new TextRun({ text: `"${text}"`, font: 'Arial', size: 20, italics: true })];
  if (meta) {
    children.push(new TextRun({ text: `  — ${meta}`, font: 'Arial', size: 18, italics: true, color: '666666' }));
  }
  return new Paragraph({
    children,
    spacing: { before: 60, after: 80, left: 360 },
    border: {
      left: { style: BorderStyle.SINGLE, size: 12, color: AMBER, space: 8 },
    },
  });
}

function spacer() {
  return new Paragraph({ children: [new TextRun('')], spacing: { after: 80 } });
}

function makeTableCell(text, isLabel = false) {
  const cellWidth = Math.floor((PAGE_WIDTH_DXA - MARGIN_DXA * 2) / 2);
  return new TableCell({
    width: { size: cellWidth, type: WidthType.DXA },
    shading: isLabel
      ? { type: ShadingType.CLEAR, color: 'auto', fill: GRAY_BG }
      : { type: ShadingType.CLEAR, color: 'auto', fill: WHITE },
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: safeStr(text),
            font: 'Arial',
            size: 20,
            bold: isLabel,
          }),
        ],
        spacing: { before: 80, after: 80 },
      }),
    ],
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
  });
}

function makeTable(rows) {
  const totalWidth = PAGE_WIDTH_DXA - MARGIN_DXA * 2;
  const colWidth = Math.floor(totalWidth / 2);

  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths: [colWidth, colWidth],
    rows: rows.map(([label, value]) =>
      new TableRow({
        children: [makeTableCell(label, true), makeTableCell(value, false)],
      })
    ),
  });
}

function buildDealSummaryRows(debrief) {
  const s = debrief.dealSummary || {};
  const outcome = (s.outcome || '').toLowerCase();
  const isLost = outcome === 'lost' || outcome === 'loss';

  const baseRows = [
    ['Account', s.account],
    ['Outcome', s.outcome],
    ['Segment', s.segment],
    ['Business Line', s.businessLine],
    ['Company Size', s.companySize],
    ['Deal Size', s.dealSize],
    ['Deal Time', s.dealTime],
    ['Source', s.source],
  ];

  if (isLost) {
    baseRows.push(
      ['Vendor Lost To', s.vendorLostTo || s.competitorMentions],
      ['Competitor Already Using', s.competitorAlreadyUsing || ''],
      ['Stage Deal Died', s.stageDealDied || ''],
      ['Primary Loss Reason', s.primaryReason],
      ['Secondary Factors', Array.isArray(s.secondaryReasons) ? s.secondaryReasons.join('; ') : s.secondaryReasons],
      ['Confidence', s.confidence]
    );
  } else {
    baseRows.push(
      ['Competitors Beaten', s.competitorMentions],
      ['Primary Win Reason', s.primaryReason],
      ['Secondary Factors', Array.isArray(s.secondaryReasons) ? s.secondaryReasons.join('; ') : s.secondaryReasons],
      ['Confidence', s.confidence]
    );
  }

  return baseRows;
}

const ANALYSIS_SECTION_LABELS = {
  problemDefinition: 'Problem Definition',
  requirements: 'Requirements & Must-Haves',
  currentWayOfWorking: 'Current Way of Working',
  productFit: 'Product Fit',
  pricingAndValue: 'Pricing & Value',
  competition: 'Competition',
  salesExecution: 'Sales Execution',
  buyingProcess: 'Buying Process',
  timingAndUrgency: 'Timing & Urgency',
  companySizeFit: 'Company Size & Segment Fit',
  emotionalSignals: 'Emotional & Perception Signals',
};

function buildAnalysisSections(analysis) {
  const elements = [];

  for (const [key, label] of Object.entries(ANALYSIS_SECTION_LABELS)) {
    const section = (analysis || {})[key] || {};
    const bullets = Array.isArray(section.bullets) ? section.bullets.filter(Boolean) : [];
    const quotes = Array.isArray(section.quotes) ? section.quotes.filter(q => q && q.text) : [];

    if (!bullets.length && !quotes.length) continue;

    elements.push(heading2(label));

    bullets.forEach(b => elements.push(bulletPara(b)));

    if (quotes.length) {
      elements.push(spacer());
      quotes.forEach(q => elements.push(quotePara(q)));
    }

    elements.push(spacer());
  }

  return elements;
}

function buildImplicationsSections(implications) {
  const elements = [];

  const product = implications.product || {};
  const productEntries = [
    ['Workflows Resonating', product.workflowsResonating],
    ['Capabilities Requested', product.capabilitiesRequested],
    ['Features Driving Wins', product.featuresDrivingWins],
    ['What to Build Next', product.whatToBuildNext],
    ['Product Gaps Causing Losses', product.productGapsCausingLosses],
  ].filter(([, arr]) => Array.isArray(arr) && arr.length);

  if (productEntries.length) {
    elements.push(heading2('Product'));
    productEntries.forEach(([label, items]) => {
      elements.push(heading3(label));
      items.forEach(item => elements.push(bulletPara(item)));
    });
    elements.push(spacer());
  }

  const sales = implications.sales || {};
  const salesEntries = [
    ['Winning Talk Tracks', sales.winningTalkTracks],
    ['Discovery Questions', sales.discoveryQuestions],
    ['Repeated Objections', sales.repeatedObjections],
    ['Demo Moments That Work', sales.demoMomentsThatWork],
    ['Competitor Counters', sales.competitorCounters],
    ['Coaching Needed', sales.coachingNeeded],
    ['What to Say Differently', sales.whatToSayDifferently],
    ['What to Avoid Saying', sales.whatToAvoidSaying],
  ].filter(([, arr]) => Array.isArray(arr) && arr.length);

  if (salesEntries.length) {
    elements.push(heading2('Sales'));
    salesEntries.forEach(([label, items]) => {
      elements.push(heading3(label));
      items.forEach(item => elements.push(bulletPara(item)));
    });
    elements.push(spacer());
  }

  const marketing = implications.marketing || {};
  const marketingEntries = [
    ['Buyer Language to Reuse', marketing.buyerLanguageToReuse],
    ['Problem Statements', marketing.problemStatements],
    ['Workflow Language', marketing.workflowLanguage],
    ['Quotes for Assets', marketing.quotesForAssets],
    ['Assets to Create', marketing.assetsToCreate],
    ['Objections Needing Content', marketing.objectionsNeedingContent],
    ['Competitors Needing Messaging', marketing.competitorsNeedingMessaging],
    ['Strongest Claims', marketing.strongestClaims],
    ['Messages Not Resonating', marketing.messagesNotResonating],
  ].filter(([, arr]) => Array.isArray(arr) && arr.length);

  if (marketingEntries.length) {
    elements.push(heading2('Marketing'));
    marketingEntries.forEach(([label, items]) => {
      elements.push(heading3(label));
      items.forEach(item => elements.push(bulletPara(item)));
    });
    elements.push(spacer());
  }

  return elements;
}

function buildRecommendedActions(actions) {
  const elements = [];
  const a = actions || {};

  const sections = [
    ['Quick Wins', a.quickWins],
    ['Medium-Term Improvements', a.mediumTerm],
    ['Strategic Bets', a.strategicBets],
  ].filter(([, arr]) => Array.isArray(arr) && arr.length);

  if (!sections.length) return elements;

  sections.forEach(([label, items]) => {
    elements.push(heading2(label));
    items.forEach((item, i) => elements.push(numberedPara(item, i + 1)));
    elements.push(spacer());
  });

  return elements;
}

function buildCoverLine(debrief, companyName) {
  const s = debrief.dealSummary || {};
  const account = s.account || companyName || 'Unknown';
  const outcome = s.outcome ? (s.outcome.charAt(0).toUpperCase() + s.outcome.slice(1)) : 'Unknown';

  // Try to get month/year from deal close date in hubspot or use today
  const now = new Date();
  const monthYear = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({
        text: `${account} — ${outcome} — ${monthYear}`,
        font: 'Arial',
        size: 40,
        bold: true,
      }),
    ],
    spacing: { before: 480, after: 480 },
  });
}

async function generateDocx(debrief, companyName) {
  const s = debrief.dealSummary || {};
  const account = s.account || companyName || 'Company';
  const outcome = s.outcome ? (s.outcome.charAt(0).toUpperCase() + s.outcome.slice(1)) : 'Unknown';
  const now = new Date();
  const monthYear = now.toLocaleString('en-US', { month: 'long', year: 'numeric' }).replace(' ', '');

  const filename = `${account.replace(/[^a-zA-Z0-9]/g, '_')}_${outcome}_${monthYear}.docx`;
  const outputPath = path.join(__dirname, '..', 'outputs', filename);

  const numbering = makeNumberingConfig();

  const children = [
    buildCoverLine(debrief, companyName),
    spacer(),
    heading1('Deal Summary'),
    makeTable(buildDealSummaryRows(debrief)),
    spacer(),
    heading1('Analysis'),
    ...buildAnalysisSections(debrief.analysis),
    heading1('Cross-Functional Implications'),
    ...buildImplicationsSections(debrief.implications || {}),
    heading1('Recommended Actions'),
    ...buildRecommendedActions(debrief.recommendedActions),
  ];

  const doc = new Document({
    numbering,
    sections: [
      {
        properties: {
          page: {
            size: {
              width: PAGE_WIDTH_DXA,
              height: PAGE_HEIGHT_DXA,
            },
            margin: {
              top: MARGIN_DXA,
              right: MARGIN_DXA,
              bottom: MARGIN_DXA,
              left: MARGIN_DXA,
            },
          },
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);

  return { filename, outputPath };
}

module.exports = { generateDocx };
