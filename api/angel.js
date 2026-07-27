// JIYA Back Office — Angel One API Proxy (Vercel Serverless)
// Handles: login, ltp, ltp_single, search_token, instrument_master, sample_master

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, apiKey, jwtToken, payload, loginPayload } = req.body || {};

  // Helper: fetch with timeout
  const fetchT = (url, opts, ms = 8000) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
  };

  // Headers builder
  const H = (key, jwt) => ({
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '192.168.1.1',
    'X-ClientPublicIP': '106.193.147.98',
    'X-MACAddress': 'fe80::216e:6507:4b90:3719',
    'X-PrivateKey': key || '',
    'X-Api-Key': key || '',
    ...(jwt ? { 'Authorization': `Bearer ${jwt}` } : {}),
  });

  // TOTP generator from secret
  const genTOTP = async (secret) => {
    try {
      const clean = secret.replace(/\s/g, '').toUpperCase();
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      let bits = '';
      for (const c of clean) {
        const idx = chars.indexOf(c);
        if (idx < 0) continue;
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
      return code.toString().padStart(6, '0');
    } catch(e) { return secret; }
  };

  try {
    // ── LOGIN ──────────────────────────────────────────────────
    if (action === 'login') {
      const { clientId, password, totp } = payload || {};
      let totpCode = totp;
      if (totp && totp.length > 6) totpCode = await genTOTP(totp);

      const r = await fetchT(
        'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword',
        { method: 'POST', headers: H(apiKey), body: JSON.stringify({ clientcode: clientId, password, totp: totpCode }) }
      );
      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch(e) {
        return res.status(200).json({ status: false, message: `Angel One error (${r.status}): ${text.slice(0, 100)}` });
      }
      console.log('Login response:', JSON.stringify(json).slice(0, 200));
      return res.status(200).json(json);
    }

    // ── LTP (batch) ────────────────────────────────────────────
    // LOOKUP TOKENS — find Angel One tokens for given symbols
    if (action === 'lookup_tokens') {
      const { symbols } = payload || {};
      try {
        const r = await fetchT(
          'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
          { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } },
          8000
        );
        const data = await r.json();
        const result = {};
        data.forEach(x => {
          const sym = (x.symbol||'').toUpperCase();
          if (symbols.includes(sym)) {
            result[sym] = { token: String(x.token), exchange: x.exch_seg };
          }
        });
        return res.status(200).json({ status: true, data: result });
      } catch(e) {
        return res.status(200).json({ status: false, message: e.message, data: {} });
      }
    }

    if (action === 'ltp') {
      try {
        const r = await fetchT(
          'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/',
          { method: 'POST', headers: H(apiKey, jwtToken), body: JSON.stringify({ mode: 'LTP', exchangeTokens: payload.exchangeTokens }) }
        );
        const text = await r.text();
        if (text.trim().startsWith('<')) return res.status(200).json({ status: false, message: 'Session expired', data: { fetched: [] } });
        return res.status(200).json(JSON.parse(text));
      } catch(e) {
        return res.status(200).json({ status: false, message: e.message, data: { fetched: [] } });
      }
    }

    // ── SINGLE LTP ─────────────────────────────────────────────
    if (action === 'ltp_single') {
      const { exchange, tradingsymbol, symboltoken } = payload || {};
      try {
        const r = await fetchT(
          'https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getLtpData',
          { method: 'POST', headers: H(apiKey, jwtToken), body: JSON.stringify({ exchange, tradingsymbol, symboltoken }) }
        );
        const text = await r.text();
        if (text.trim().startsWith('<')) return res.status(200).json({ status: false, message: 'Session expired' });
        return res.status(200).json(JSON.parse(text));
      } catch(e) {
        return res.status(200).json({ status: false, message: e.message });
      }
    }

    // ── SEARCH TOKEN ───────────────────────────────────────────
    if (action === 'search_token') {
      const { symbol, exchange } = payload || {};
      const doSearch = async (jwt) => {
        try {
          const r = await fetchT(
            'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/searchscrip',
            { method: 'POST', headers: H(apiKey, jwt), body: JSON.stringify({ exchange: exchange || 'NFO', searchscrip: symbol }) }
          );
          const text = await r.text();
          if (text.trim().startsWith('<')) return null;
          return JSON.parse(text);
        } catch(e) { return null; }
      };
      let data = await doSearch(jwtToken);
      if (!data && loginPayload?.clientId) {
        let freshTotp = loginPayload.totp;
        if (loginPayload.totp && loginPayload.totp.length > 6) freshTotp = await genTOTP(loginPayload.totp);
        try {
          const relogin = await fetchT(
            'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword',
            { method: 'POST', headers: H(apiKey), body: JSON.stringify({ clientcode: loginPayload.clientId, password: loginPayload.password, totp: freshTotp }) }
          );
          const redata = await relogin.json();
          console.log('Relogin:', redata.status, redata.message, 'totp:', freshTotp);
          if (redata.status && redata.data?.jwtToken) data = await doSearch(redata.data.jwtToken);
        } catch(e) {}
      }
      if (!data) return res.status(200).json({ status: false, message: 'Session expired or search failed', data: [] });
      return res.status(200).json(data);
    }

    // ── INSTRUMENT MASTER ──────────────────────────────────────
    if (action === 'instrument_master') {
      try {
        const r = await fetchT(
          'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
          { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } },
          8000
        );
        const data = await r.json();
        const filtered = data.filter(x => x.exch_seg === 'NFO' || x.exch_seg === 'BFO');
        return res.status(200).json({ status: true, data: filtered });
      } catch(e) {
        return res.status(200).json({ status: false, message: e.message, data: [] });
      }
    }

    // ── SAMPLE MASTER (debug) ──────────────────────────────────
    if (action === 'sample_master') {
      try {
        const r = await fetchT(
          'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
          { headers: { 'User-Agent': 'Mozilla/5.0' } },
          8000
        );
        const data = await r.json();
        const sample = data.filter(x => x.exch_seg === 'BFO' && x.symbol?.includes('SENSEX') && x.symbol?.includes('PE')).slice(0, 20);
        return res.status(200).json({ status: true, data: sample.map(x => ({ symbol: x.symbol, token: x.token })) });
      } catch(e) {
        return res.status(200).json({ status: false, message: e.message });
      }
    }

    return res.status(400).json({ status: false, message: `Unknown action: ${action}` });

  } catch(e) {
    console.error('Angel proxy error:', e.message);
    return res.status(200).json({ status: false, message: e.message });
  }
}
