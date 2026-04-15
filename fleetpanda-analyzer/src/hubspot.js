'use strict';

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const HUBSPOT_BASE = 'https://api.hubapi.com';

async function hubspotRequest(endpoint, options = {}) {
  const apiKey = process.env.HUBSPOT_API_KEY;
  if (!apiKey) throw new Error('HUBSPOT_API_KEY not set in .env');

  const url = `${HUBSPOT_BASE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot API error ${res.status}: ${text}`);
  }

  return res.json();
}

async function searchDealByCompanyName(companyName) {
  const body = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'dealname',
            operator: 'CONTAINS_TOKEN',
            value: companyName,
          },
        ],
      },
    ],
    properties: [
      'dealname',
      'dealstage',
      'amount',
      'closedate',
      'createdate',
      'hubspot_owner_id',
      'pipeline',
      'hs_deal_stage_probability',
      'description',
      'num_contacted_notes',
      'hs_sales_email_last_replied',
      'closed_lost_reason',
      'closed_won_reason',
      'deal_currency_code',
      'hs_closed_amount',
      'hs_deal_amount_calculation_preference',
      'hs_lastmodifieddate',
      'source',
      'lead_source',
      'hs_analytics_source',
      'segment',
      'business_line',
      'competitor__won_against_',
      'previous_vendor',
      'company_size',
      'number_of_trucks',
      'annual_revenue',
      'num_employees',
      'industry',
      'notes_last_contacted',
      'notes_last_updated',
      'win_reason',
      'loss_reason',
      'competitor_lost_to',
      'competitor_already_using',
      'stage_deal_died',
    ],
    limit: 5,
    sorts: [{ propertyName: 'closedate', direction: 'DESCENDING' }],
  };

  const data = await hubspotRequest('/crm/v3/objects/deals/search', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return data.results || [];
}

async function getDealAssociations(dealId) {
  try {
    const [contactsData, companiesData, notesData] = await Promise.all([
      hubspotRequest(`/crm/v3/objects/deals/${dealId}/associations/contacts`).catch(() => ({ results: [] })),
      hubspotRequest(`/crm/v3/objects/deals/${dealId}/associations/companies`).catch(() => ({ results: [] })),
      hubspotRequest(`/crm/v3/objects/deals/${dealId}/associations/notes`).catch(() => ({ results: [] })),
    ]);
    return {
      contacts: contactsData.results || [],
      companies: companiesData.results || [],
      notes: notesData.results || [],
    };
  } catch {
    return { contacts: [], companies: [], notes: [] };
  }
}

async function getContactDetails(contactIds) {
  if (!contactIds.length) return [];
  const contacts = await Promise.all(
    contactIds.slice(0, 5).map(({ id }) =>
      hubspotRequest(`/crm/v3/objects/contacts/${id}?properties=firstname,lastname,email,jobtitle,phone`).catch(() => null)
    )
  );
  return contacts.filter(Boolean);
}

async function getCompanyDetails(companyIds) {
  if (!companyIds.length) return [];
  const companies = await Promise.all(
    companyIds.slice(0, 3).map(({ id }) =>
      hubspotRequest(`/crm/v3/objects/companies/${id}?properties=name,industry,numberofemployees,annualrevenue,city,state,country`).catch(() => null)
    )
  );
  return companies.filter(Boolean);
}

async function getNoteDetails(noteIds) {
  if (!noteIds.length) return [];
  const notes = await Promise.all(
    noteIds.slice(0, 10).map(({ id }) =>
      hubspotRequest(`/crm/v3/objects/notes/${id}?properties=hs_note_body,hs_timestamp,hubspot_owner_id`).catch(() => null)
    )
  );
  return notes.filter(Boolean);
}

async function getDealStageHistory(dealId) {
  try {
    const data = await hubspotRequest(
      `/crm/v3/objects/deals/${dealId}?properties=dealstage&propertiesWithHistory=dealstage`
    );
    return (data.propertiesWithHistory && data.propertiesWithHistory.dealstage) || [];
  } catch {
    return [];
  }
}

async function getOwnerDetails(ownerId) {
  if (!ownerId) return null;
  try {
    return await hubspotRequest(`/crm/v3/owners/${ownerId}`);
  } catch {
    return null;
  }
}

function detectOutcome(dealStage) {
  if (!dealStage) return 'unknown';
  const stage = dealStage.toLowerCase();
  if (stage.includes('closedwon') || stage.includes('closed_won') || stage.includes('won')) return 'won';
  if (stage.includes('closedlost') || stage.includes('closed_lost') || stage.includes('lost')) return 'lost';
  return 'unknown';
}

async function fetchHubSpotData(companyName) {
  const deals = await searchDealByCompanyName(companyName);

  if (!deals.length) {
    return {
      error: `No deals found in HubSpot for company name: "${companyName}"`,
      companyName,
    };
  }

  // Pick the most recent closed deal, preferring won/lost over open
  let deal = deals.find(d => {
    const stage = (d.properties.dealstage || '').toLowerCase();
    return stage.includes('won') || stage.includes('lost') || stage.includes('closed');
  }) || deals[0];

  const dealId = deal.id;
  const properties = deal.properties;
  const outcome = detectOutcome(properties.dealstage);

  const [associations, stageHistory, ownerDetails] = await Promise.all([
    getDealAssociations(dealId),
    getDealStageHistory(dealId),
    getOwnerDetails(properties.hubspot_owner_id),
  ]);

  const [contacts, companies, notes] = await Promise.all([
    getContactDetails(associations.contacts),
    getCompanyDetails(associations.companies),
    getNoteDetails(associations.notes),
  ]);

  const raw = {
    dealId,
    outcome,
    properties,
    associations: {
      contacts: contacts.map(c => c.properties),
      companies: companies.map(c => c.properties),
      notes: notes.map(n => n.properties),
    },
    stageHistory,
    owner: ownerDetails,
    allDealsFound: deals.length,
  };

  // Save raw output
  const outputPath = path.join(__dirname, '..', 'outputs', 'hubspot_raw.json');
  fs.writeFileSync(outputPath, JSON.stringify(raw, null, 2));

  return raw;
}

module.exports = { fetchHubSpotData };
