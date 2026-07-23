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
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '192.168.1.1',
    'X-ClientPublicIP': '106.193.147.98',
    'X-MACAddress': 'fe80::216e:6507:4b90:3719',
    'X-PrivateKey': key,
    'X-Api-Key': key,  // Angel One sometimes uses this header name
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

      // Generate live 6-digit TOTP from secret using RFC 6238
      const generateTOTP = async (secret) => {
        // Clean secret — remove spaces, uppercase
        const cleanSecret = secret.replace(/\s/g, '').toUpperCase();

        // Base32 decode
        const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = '';
        for (const c of cleanSecret) {
          const idx = base32Chars.indexOf(c);
          if (idx === -1) continue;
          bits += idx.toString(2).padStart(5, '0');
        }
        const bytes = new Uint8Array(Math.floor(bits.length / 8));
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(bits.slice(i*8, i*8+8), 2);
        }

        // HMAC-SHA1 with time counter
        const counter = Math.floor(Date.now() / 1000 / 30);
        const counterBytes = new Uint8Array(8);
        let c = counter;
        for (let i = 7; i >= 0; i--) { counterBytes[i] = c & 0xff; c >>= 8; }

        const key = await crypto.subtle.importKey(
          'raw', bytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
        );
        const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes));

        // Dynamic truncation
        const offset = sig[sig.length - 1] & 0xf;
        const code = ((sig[offset] & 0x7f) << 24 |
                       sig[offset+1] << 16 |
                       sig[offset+2] << 8  |
                       sig[offset+3]) % 1000000;
        return code.toString().padStart(6, '0');
      };

      // If totp looks like a secret (not 6 digits), generate the code
      let totpCode = totp;
      if (totp && totp.length > 6) {
        try {
          totpCode = await generateTOTP(totp);
        } catch(e) {
          totpCode = totp; // fallback to original
        }
      }

      const r = await fetch(
        'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword',
        { method: 'POST', headers: ANGEL_H(apiKey), body: JSON.stringify({ clientcode: clientId, password, totp: totpCode }) }
      );
      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch(e) { return res.status(200).json({ status: false, message: 'Angel One returned invalid response: ' + text.slice(0,200) }); }
      console.log('Angel One login response:', JSON.stringify(json).slice(0, 300));
      return res.status(200).json(json);
    }

    // DEBUG — sample BFO keys from instrument master
    if (action === 'sample_master') {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const r = await fetch(
          'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
          { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: controller.signal }
        );
        clearTimeout(timeout);
        const data = await r.json();
        // Find BFO SENSEX PE entries
        const sample = data.filter(x =>
          x.exch_seg === 'BFO' &&
          x.symbol && x.symbol.includes('SENSEX') &&
          x.symbol.includes('PE')
        ).slice(0, 20).map(x => ({ symbol: x.symbol, token: x.token, expiry: x.expiry }));
        return res.status(200).json({ status: true, data: sample });
      } catch(e) {
        return res.status(200).json({ status: false, message: e.message });
      }
    }

    // INSTRUMENT MASTER — fetch Angel One scrip master (no auth needed)
    if (action === 'instrument_master') {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const r = await fetch(
          'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
          { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: controller.signal }
        );
        clearTimeout(timeout);
        const data = await r.json();
        const filtered = data.filter(x => x.exch_seg === 'NFO' || x.exch_seg === 'BFO');
        return res.status(200).json({ status: true, data: filtered });
      } catch(e) {
        return res.status(200).json({ status: false, message: e.message, data: [] });
      }
    }

    // SEARCH TOKEN — find Angel One symbol token for a contract
    if (action === 'search_token') {
      const { symbol, exchange } = payload;
      const loginPayload = req.body.loginPayload; // optional creds for auto-relogin

      const doSearch = async (jwt) => {
        const r = await fetch(
          'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/searchscrip',
          {
            method: 'POST',
            headers: ANGEL_H(apiKey, jwt),
            body: JSON.stringify({ exchange: exchange || 'NFO', searchscrip: symbol })
          }
        );
        const text = await r.text();
        if (text.trim().startsWith('<')) return null; // HTML = expired
        return JSON.parse(text);
      };

      try {
        let data = await doSearch(jwtToken);

        // If expired and we have login creds, re-login and retry
        if (!data && loginPayload?.clientId) {
          // Generate fresh TOTP
          let freshTotp = loginPayload.totp;
          if (loginPayload.totp && loginPayload.totp.length > 6) {
            try {
              const cleanSecret = loginPayload.totp.replace(/\s/g, '').toUpperCase();
              const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
              let bits = '';
              for (const c of cleanSecret) {
                const idx = base32Chars.indexOf(c);
                if (idx === -1) continue;
                bits += idx.toString(2).padStart(5, '0');
              }
              const bytes = new Uint8Array(Math.floor(bits.length / 8));
              for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i*8, i*8+8), 2);
              const counter = Math.floor(Date.now() / 1000 / 30);
              const cb = new Uint8Array(8);
              let ct = counter;
              for (let i = 7; i >= 0; i--) { cb[i] = ct & 0xff; ct >>= 8; }
              const key = await crypto.subtle.importKey('raw', bytes, { name:'HMAC', hash:'SHA-1' }, false, ['sign']);
              const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, cb));
              const off = sig[sig.length-1] & 0xf;
              const code = ((sig[off]&0x7f)<<24|sig[off+1]<<16|sig[off+2]<<8|sig[off+3]) % 1000000;
              freshTotp = code.toString().padStart(6, '0');
            } catch(e) {}
          }
          const relogin = await fetch(
            'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword',
            {
              method: 'POST',
              headers: ANGEL_H(apiKey),
              body: JSON.stringify({
                clientcode: loginPayload.clientId,
                password:   loginPayload.password,
                totp:       freshTotp
              })
            }
          );
          const redata = await relogin.json();
          console.log('Relogin result:', redata.status, redata.message, 'totp used:', freshTotp);
          if (redata.status && redata.data?.jwtToken) {
            data = await doSearch(redata.data.jwtToken);
          }
        }

        if (!data) {
          return res.status(200).json({ status: false, message: 'Session expired — reconnect Angel One in Settings', data: [] });
        }
        return res.status(200).json(data);
      } catch(e) {
        return res.status(200).json({ status: false, message: e.message, data: [] });
      }
    }

    // LTP
    // SINGLE LTP — more reliable for individual contracts
    if (action === 'ltp_single') {
      const { exchange, tradingsymbol, symboltoken } = payload;
      try {
        const r = await fetch(
          'https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getLtpData',
          {
            method: 'POST',
            headers: ANGEL_H(apiKey, jwtToken),
            body: JSON.stringify({ exchange, tradingsymbol, symboltoken })
          }
        );
        const text = await r.text();
        if (text.trim().startsWith('<')) return res.status(200).json({ status: false, message: 'Session expired' });
        return res.status(200).json(JSON.parse(text));
      } catch(e) {
        return res.status(200).json({ status: false, message: e.message });
      }
    }

    // LTP (batch)
      try {
        const r = await fetch(
          'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/',
          { method: 'POST', headers: ANGEL_H(apiKey, jwtToken), body: JSON.stringify({ mode: 'LTP', exchangeTokens: payload.exchangeTokens }) }
        );
        const text = await r.text();
        if (text.trim().startsWith('<')) return res.status(200).json({ status: false, message: 'Session expired', data: { fetched: [] } });
        return res.status(200).json(JSON.parse(text));
      } catch(e) {
        return res.status(200).json({ status: false, message: e.message, data: { fetched: [] } });
      }
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
            'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData',
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
