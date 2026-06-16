// Vercel Serverless Function — Angel One API Proxy
// File location in GitHub repo: api/angel.js

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, payload, apiKey, jwtToken } = req.body;

  const ANGEL_H = (key, jwt) => ({
    'Content-Type': 'application/json', 'Accept': 'application/json',
    'X-UserType': 'USER', 'X-SourceID': 'WEB',
    'X-ClientLocalIP': '192.168.1.1', 'X-ClientPublicIP': '106.193.147.98',
    'X-MACAddress': 'fe80::216e:6507:4b90:3719',
    'X-PrivateKey': key,
    ...(jwt ? { 'Authorization': `Bearer ${jwt}` } : {}),
  });

  const SUPABASE_URL = 'https://jwfucitnaqkuyzizmuve.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3ZnVjaXRuYXFrdXl6aXptdXZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MTIyNDIsImV4cCI6MjA5MTE4ODI0Mn0.62UKN69g9qXoSipj_JdVtMt7JNcX03e-CeVWwOC3s6A';
  const SB_H = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=minimal',
  };

  try {
    // LOGIN
    if (action === 'login') {
      const { clientId, password, totp } = payload;
      const r = await fetch(
        'https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword',
        { method: 'POST', headers: ANGEL_H(apiKey), body: JSON.stringify({ clientcode: clientId, password, totp }) }
      );
      return res.status(200).json(await r.json());
    }

    // LTP
    if (action === 'ltp') {
      const r = await fetch(
        'https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/',
        { method: 'POST', headers: ANGEL_H(apiKey, jwtToken), body: JSON.stringify({ mode: 'LTP', exchangeTokens: payload.exchangeTokens }) }
      );
      return res.status(200).json(await r.json());
    }

    // CLOSING PRICES - fetch historical EOD prices for open positions
    if (action === 'closing_prices') {
      const { positions, date } = payload;
      let targetDate = date;
      if (!targetDate) {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
        targetDate = d.toISOString().slice(0, 10);
      }
      const results = {};
      const errors  = [];
      for (const pos of positions) {
        try {
          const r = await fetch(
            'https://apiconnect.angelbroking.com/rest/secure/angelbroking/historical/v1/getCandleData',
            {
              method: 'POST', headers: ANGEL_H(apiKey, jwtToken),
              body: JSON.stringify({
                exchange: pos.exchange, symboltoken: pos.token,
                interval: 'ONE_DAY',
                fromdate: `${targetDate} 09:15`, todate: `${targetDate} 15:30`,
              })
            }
          );
          const data = await r.json();
          if (data.status && data.data?.length > 0) {
            const close = data.data[data.data.length - 1][4];
            results[pos.contract] = { closePrice: close, token: pos.token, exchange: pos.exchange, date: targetDate };
          } else {
            errors.push(`${pos.contract}: ${data.message || 'no data'}`);
          }
          await new Promise(r => setTimeout(r, 120));
        } catch(e) { errors.push(`${pos.contract}: ${e.message}`); }
      }
      // Save to Supabase bhavcopy table
      const rows = Object.entries(results).map(([contract, d]) => ({
        contract, closePrice: d.closePrice, settlPrice: d.closePrice,
        bhavDate: targetDate, exchange: d.exchange, token: d.token,
      }));
      if (rows.length > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/bhavcopy?bhavDate=eq.${targetDate}`, { method: 'DELETE', headers: SB_H });
        await fetch(`${SUPABASE_URL}/rest/v1/bhavcopy`, { method: 'POST', headers: SB_H, body: JSON.stringify(rows) });
      }
      return res.status(200).json({ status: true, date: targetDate, results, errors, saved: rows.length });
    }

    // RMS UPLOAD
    if (action === 'rms_upload') {
      const { positions, totalMtm, timestamp, rowCount } = payload;
      await fetch(`${SUPABASE_URL}/rest/v1/rms_positions?snapshot_type=eq.live`, { method: 'DELETE', headers: SB_H });
      const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/rms_positions`, {
        method: 'POST', headers: SB_H,
        body: JSON.stringify({ positions_json: JSON.stringify(positions), snapshot_type: 'live', uploaded_at: timestamp || new Date().toISOString() }),
      });
      if (!insertResp.ok) return res.status(500).json({ error: await insertResp.text() });
      return res.status(200).json({ success: true, count: rowCount || positions.length, clients: Object.keys(totalMtm || {}).length });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
