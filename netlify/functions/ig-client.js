// netlify/functions/ig-client.js
// IG Markets API client
// Handles authentication, price fetching, historical data and order execution
// Docs: https://labs.ig.com/rest-trading-api-reference

const getBaseUrl = () => process.env.IG_DEMO === 'true'
  ? 'https://demo-api.ig.com/gateway/deal'
  : 'https://api.ig.com/gateway/deal';

// ── AUTHENTICATION ────────────────────────────────────────────────────────────
// IG uses session tokens that need refreshing
// Returns { CST, X-SECURITY-TOKEN } headers for subsequent calls

async function authenticate() {
  const url = `${getBaseUrl()}/session`;
  const res  = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':   'application/json',
      'Accept':         'application/json; charset=UTF-8',
      'X-IG-API-KEY':   process.env.IG_API_KEY,
      'Version':        '2'
    },
    body: JSON.stringify({
      identifier:         process.env.IG_USERNAME,
      password:           process.env.IG_PASSWORD,
      encryptedPassword:  false
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`IG auth failed: ${res.status} — ${err}`);
  }

  const cst           = res.headers.get('CST');
  const securityToken = res.headers.get('X-SECURITY-TOKEN');
  const data          = await res.json();

  if (!cst || !securityToken) {
    throw new Error('IG auth: no session tokens in response');
  }

  return {
    cst,
    securityToken,
    accountId:   data.currentAccountId || process.env.IG_ACCOUNT_ID,
    headers: {
      'Content-Type':      'application/json',
      'Accept':            'application/json; charset=UTF-8',
      'X-IG-API-KEY':      process.env.IG_API_KEY,
      'CST':               cst,
      'X-SECURITY-TOKEN':  securityToken
    }
  };
}

// ── IG API REQUEST ────────────────────────────────────────────────────────────
async function igRequest(path, method = 'GET', body = null, version = '1') {
  const session = await authenticate();
  const url     = `${getBaseUrl()}${path}`;
  const opts    = {
    method,
    headers: { ...session.headers, 'Version': version }
  };
  if (body) opts.body = JSON.stringify(body);

  const res  = await fetch(url, opts);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(`IG API error ${res.status}: ${JSON.stringify(data)}`);
  }

  return { data, session };
}

// ── SEARCH FOR EPIC ───────────────────────────────────────────────────────────
// IG uses EPICs (instrument codes) not ASX tickers
// ASX stocks are usually ticker.AU e.g. BHP.AU, CBA.AU

async function searchEpic(ticker) {
  try {
    const { data } = await igRequest(`/markets?searchTerm=${ticker}&epic=${ticker}.AU`, 'GET', null, '1');
    if (data.markets?.length > 0) {
      // Find exact ASX match
      const match = data.markets.find(m =>
        m.epic === `${ticker}.AU` ||
        m.instrumentName?.toUpperCase().includes(ticker.toUpperCase())
      );
      return match?.epic || data.markets[0]?.epic;
    }
    return `${ticker}.AU`; // default format
  } catch (e) {
    return `${ticker}.AU`;
  }
}

// ── GET LIVE PRICE ────────────────────────────────────────────────────────────
async function getLivePrice(ticker) {
  try {
    const epic   = `${ticker}.AU`;
    const { data } = await igRequest(`/markets/${epic}`, 'GET', null, '3');
    const snap   = data.snapshot;
    if (!snap) return null;

    const bid = parseFloat(snap.bid);
    const ask = parseFloat(snap.offer);
    const mid = (bid + ask) / 2;
    const prev = parseFloat(snap.netChange) ? mid - parseFloat(snap.netChange) : mid;

    return {
      ticker,
      epic,
      price:     parseFloat(mid.toFixed(4)),
      bid:       parseFloat(bid.toFixed(4)),
      ask:       parseFloat(ask.toFixed(4)),
      change:    parseFloat(snap.netChange || 0),
      changePct: parseFloat(snap.percentageChange || 0) / 100,
      high:      parseFloat(snap.high || mid),
      low:       parseFloat(snap.low  || mid),
      volume:    parseInt(snap.updateTime || 0),
      open:      parseFloat(snap.open || mid)
    };
  } catch (e) {
    console.error(`IG price error for ${ticker}:`, e.message);
    return null;
  }
}

// ── GET HISTORICAL PRICES ─────────────────────────────────────────────────────
// resolution: DAY, WEEK, MONTH, HOUR, MINUTE_30 etc
// numPoints: number of data points to return (max 1000 per call)

async function getHistoricalPrices(ticker, resolution = 'DAY', numPoints = 250) {
  try {
    const epic = `${ticker}.AU`;
    const { data } = await igRequest(
      `/prices/${epic}?resolution=${resolution}&max=${numPoints}&pageSize=0`,
      'GET', null, '3'
    );

    if (!data.prices?.length) return null;

    const prices = data.prices.map(p => ({
      date:   p.snapshotTime,
      open:   parseFloat(((p.openPrice.bid + p.openPrice.ask) / 2).toFixed(4)),
      high:   parseFloat(((p.highPrice.bid + p.highPrice.ask) / 2).toFixed(4)),
      low:    parseFloat(((p.lowPrice.bid  + p.lowPrice.ask)  / 2).toFixed(4)),
      close:  parseFloat(((p.closePrice.bid + p.closePrice.ask) / 2).toFixed(4)),
      volume: parseInt(p.lastTradedVolume || 0)
    }));

    return prices;
  } catch (e) {
    console.error(`IG history error for ${ticker}:`, e.message);
    return null;
  }
}

// ── GET ACCOUNT INFO ──────────────────────────────────────────────────────────
async function getAccountInfo() {
  const { data } = await igRequest('/accounts', 'GET', null, '1');
  return data.accounts || [];
}

// ── GET OPEN POSITIONS ────────────────────────────────────────────────────────
async function getPositions() {
  const { data } = await igRequest('/positions', 'GET', null, '2');
  return data.positions || [];
}

// ── PLACE ORDER (Share Trading) ───────────────────────────────────────────────
// direction: 'BUY' or 'SELL'
// size: number of shares
// orderType: 'MARKET' or 'LIMIT'
// limitPrice: required for LIMIT orders

async function placeOrder({
  ticker,
  direction,
  size,
  orderType = 'MARKET',
  limitPrice = null,
  stopLoss = null,
  takeProfit = null
}) {
  const epic = `${ticker}.AU`;

  const order = {
    epic,
    direction,
    size,
    orderType,
    currencyCode:    'AUD',
    timeInForce:     orderType === 'MARKET' ? 'EXECUTE_AND_ELIMINATE' : 'GOOD_TILL_CANCELLED',
    guaranteedStop:  false,
    forceOpen:       false
  };

  if (orderType === 'LIMIT' && limitPrice) {
    order.level = limitPrice;
  }

  if (stopLoss) {
    order.stopLevel = stopLoss;
  }

  if (takeProfit) {
    order.limitLevel = takeProfit;
  }

  const { data } = await igRequest('/positions/otc', 'POST', order, '2');
  return data;
}

// ── CLOSE POSITION ────────────────────────────────────────────────────────────
async function closePosition(dealId, size, direction) {
  const { data } = await igRequest('/positions/otc', 'DELETE', {
    dealId,
    direction: direction === 'BUY' ? 'SELL' : 'BUY',
    size,
    orderType: 'MARKET',
    timeInForce: 'EXECUTE_AND_ELIMINATE'
  }, '1');
  return data;
}

// ── GET DEAL CONFIRMATION ─────────────────────────────────────────────────────
async function getDealConfirmation(dealReference) {
  const { data } = await igRequest(`/confirms/${dealReference}`, 'GET', null, '1');
  return data;
}

module.exports = {
  authenticate,
  getLivePrice,
  getHistoricalPrices,
  getAccountInfo,
  getPositions,
  placeOrder,
  closePosition,
  getDealConfirmation,
  searchEpic,
  igRequest
};
