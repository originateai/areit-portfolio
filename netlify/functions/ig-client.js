// netlify/functions/ig-client.js
// IG Markets API client — updated for migrated accounts

const getBaseUrl = () => process.env.IG_DEMO === 'true' || process.env.IG_DEMO === true
  ? 'https://demo-api.ig.com/gateway/deal'
  : 'https://api.ig.com/gateway/deal';

async function authenticate() {
  const baseUrl = getBaseUrl();
  
  // Step 1 — Create session with email + password
  const res = await fetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Accept':        'application/json; charset=UTF-8',
      'X-IG-API-KEY':  process.env.IG_API_KEY,
      'Version':       '3'
    },
    body: JSON.stringify({
      identifier:        process.env.IG_USERNAME,
      password:          process.env.IG_PASSWORD,
      encryptedPassword: false
    })
  });

  const body = await res.text();
  
  if (!res.ok) {
    throw new Error(`IG auth failed: ${res.status} — ${body}`);
  }

  const cst           = res.headers.get('CST');
  const securityToken = res.headers.get('X-SECURITY-TOKEN');
  const data          = JSON.parse(body);

  if (!cst || !securityToken) {
    throw new Error(`IG auth: missing session tokens. Response: ${body}`);
  }

  const sessionHeaders = {
    'Content-Type':      'application/json',
    'Accept':            'application/json; charset=UTF-8',
    'X-IG-API-KEY':      process.env.IG_API_KEY,
    'CST':               cst,
    'X-SECURITY-TOKEN':  securityToken
  };

  // Step 2 — Switch to specific account if needed
  const accountId = process.env.IG_ACCOUNT_ID;
  if (accountId && data.currentAccountId !== accountId) {
    try {
      await fetch(`${baseUrl}/session`, {
        method: 'PUT',
        headers: { ...sessionHeaders, 'Version': '1' },
        body: JSON.stringify({ accountId, defaultAccount: false })
      });
    } catch(e) {
      console.log('Account switch note:', e.message);
    }
  }

  return {
    cst,
    securityToken,
    accountId: accountId || data.currentAccountId,
    headers:   sessionHeaders
  };
}

async function igRequest(path, method = 'GET', body = null, version = '1') {
  const session = await authenticate();
  const url     = `${getBaseUrl()}${path}`;
  const opts    = {
    method,
    headers: { ...session.headers, 'Version': version }
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { data = { raw: text }; }
  if (!res.ok) throw new Error(`IG API ${res.status}: ${text}`);
  return { data, session };
}

async function getLivePrice(ticker) {
  try {
    const epic     = `${ticker}.AU`;
    const { data } = await igRequest(`/markets/${epic}`, 'GET', null, '3');
    const snap     = data.snapshot;
    if (!snap) return null;
    const bid  = parseFloat(snap.bid   || 0);
    const ask  = parseFloat(snap.offer || 0);
    const mid  = bid && ask ? (bid + ask) / 2 : bid || ask;
    return {
      ticker, epic,
      price:     parseFloat(mid.toFixed(4)),
      bid:       parseFloat(bid.toFixed(4)),
      ask:       parseFloat(ask.toFixed(4)),
      change:    parseFloat(snap.netChange       || 0),
      changePct: parseFloat(snap.percentageChange|| 0) / 100,
      high:      parseFloat(snap.high || mid),
      low:       parseFloat(snap.low  || mid),
      open:      parseFloat(snap.open || mid),
      volume:    0
    };
  } catch(e) {
    console.error(`IG price error ${ticker}:`, e.message);
    return null;
  }
}

async function getHistoricalPrices(ticker, resolution = 'DAY', numPoints = 250) {
  try {
    const epic     = `${ticker}.AU`;
    const { data } = await igRequest(
      `/prices/${epic}?resolution=${resolution}&max=${numPoints}&pageSize=0`,
      'GET', null, '3'
    );
    if (!data.prices?.length) return null;
    return data.prices.map(p => ({
      date:   p.snapshotTime,
      open:   parseFloat(((p.openPrice.bid  + p.openPrice.ask)  / 2).toFixed(4)),
      high:   parseFloat(((p.highPrice.bid  + p.highPrice.ask)  / 2).toFixed(4)),
      low:    parseFloat(((p.lowPrice.bid   + p.lowPrice.ask)   / 2).toFixed(4)),
      close:  parseFloat(((p.closePrice.bid + p.closePrice.ask) / 2).toFixed(4)),
      volume: parseInt(p.lastTradedVolume || 0)
    }));
  } catch(e) {
    console.error(`IG history error ${ticker}:`, e.message);
    return null;
  }
}

async function getAccountInfo() {
  const { data } = await igRequest('/accounts', 'GET', null, '1');
  return data.accounts || [];
}

async function getPositions() {
  const { data } = await igRequest('/positions', 'GET', null, '2');
  return data.positions || [];
}

async function placeOrder({ ticker, direction, size, orderType='MARKET', limitPrice=null, stopLoss=null, takeProfit=null }) {
  const order = {
    epic:         `${ticker}.AU`,
    direction,
    size,
    orderType,
    currencyCode: 'AUD',
    timeInForce:  orderType==='MARKET' ? 'EXECUTE_AND_ELIMINATE' : 'GOOD_TILL_CANCELLED',
    guaranteedStop: false,
    forceOpen:    false
  };
  if (orderType==='LIMIT' && limitPrice) order.level = limitPrice;
  if (stopLoss)   order.stopLevel  = stopLoss;
  if (takeProfit) order.limitLevel = takeProfit;
  const { data } = await igRequest('/positions/otc', 'POST', order, '2');
  return data;
}

async function closePosition(dealId, size, direction) {
  const { data } = await igRequest('/positions/otc', 'DELETE', {
    dealId,
    direction: direction==='BUY' ? 'SELL' : 'BUY',
    size, orderType: 'MARKET',
    timeInForce: 'EXECUTE_AND_ELIMINATE'
  }, '1');
  return data;
}

async function getDealConfirmation(dealReference) {
  const { data } = await igRequest(`/confirms/${dealReference}`, 'GET', null, '1');
  return data;
}

module.exports = {
  authenticate, getLivePrice, getHistoricalPrices,
  getAccountInfo, getPositions, placeOrder,
  closePosition, getDealConfirmation, igRequest
};
