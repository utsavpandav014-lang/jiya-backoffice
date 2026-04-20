// Vercel Serverless Function — Angel One API Proxy
// Place this file at: api/angel.js in your GitHub repo root

export default async function handler(req, res) {
  // Allow CORS from your own site
  res.setHeader('Access-Control-Allow-Origin', 'https://app.securetrading.co.in');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, payload, apiKey, jwtToken } = req.body;

  try {
    // ── Action: LOGIN ──────────────────────────────────────
    if (action === 'login') {
      const { clientId, password, totp } = payload;

      const response = await fetch(
        'https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword',
        {
          method: 'POST',
          headers: {
            'Content-Type':       'application/json',
            'Accept':             'application/json',
            'X-UserType':         'USER',
            'X-SourceID':         'WEB',
            'X-ClientLocalIP':    '192.168.1.1',
            'X-ClientPublicIP':   '106.193.147.98',
            'X-MACAddress':       'fe80::216e:6507:4b90:3719',
            'X-PrivateKey':       apiKey,
          },
          body: JSON.stringify({ clientcode: clientId, password, totp }),
        }
      );

      const data = await response.json();
      return res.status(200).json(data);
    }

    // ── Action: GET LTP (live prices) ─────────────────────
    // Supports NFO (NSE F&O), BFO (BSE F&O), NSE, BSE
    if (action === 'ltp') {
      const { exchangeTokens } = payload;

      const response = await fetch(
        'https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/',
        {
          method: 'POST',
          headers: {
            'Content-Type':       'application/json',
            'Accept':             'application/json',
            'X-UserType':         'USER',
            'X-SourceID':         'WEB',
            'X-ClientLocalIP':    '192.168.1.1',
            'X-ClientPublicIP':   '106.193.147.98',
            'X-MACAddress':       'fe80::216e:6507:4b90:3719',
            'X-PrivateKey':       apiKey,
            'Authorization':      `Bearer ${jwtToken}`,
          },
          body: JSON.stringify({ mode: 'LTP', exchangeTokens }),
        }
      );

      const data = await response.json();
      return res.status(200).json(data);
    }

    // ── Action: GET INSTRUMENT MASTER ─────────────────────
    if (action === 'instruments') {
      const response = await fetch(
        'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json'
      );
      const data = await response.json();
      // Filter only NFO options to reduce size
      const filtered = data.filter(i =>
        i.exch_seg === 'NFO' &&
        (i.instrumenttype === 'OPTIDX' || i.instrumenttype === 'OPTSTK') &&
        (i.name === 'NIFTY' || i.name === 'SENSEX' || i.name === 'BANKNIFTY' || i.name === 'BANKEX')
      );
      return res.status(200).json(filtered);
    }

    // ── Action: RMS UPLOAD (from Windows tool) ────────────
    if (action === 'rms_upload') {
      const { positions, totalMtm, timestamp, rowCount } = payload;

      const supabaseUrl = 'https://jwfucitnaqkuyzizmuve.supabase.co';
      const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3ZnVjaXRuYXFrdXl6aXptdXZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MTIyNDIsImV4cCI6MjA5MTE4ODI0Mn0.62UKN69g9qXoSipj_JdVtMt7JNcX03e-CeVWwOC3s6A';
      const headers = {
        'Content-Type':  'application/json',
        'apikey':        supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer':        'return=minimal',
      };

      // Step 1: Delete old records (keep DB clean — only latest needed)
      await fetch(`${supabaseUrl}/rest/v1/rms_positions?snapshot_type=eq.live`, {
        method: 'DELETE', headers
      });

      // Step 2: Insert new snapshot
      const insertResp = await fetch(`${supabaseUrl}/rest/v1/rms_positions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          positions_json: JSON.stringify(positions),
          snapshot_type:  'live',
          uploaded_at:    timestamp || new Date().toISOString(),
        }),
      });

      if (!insertResp.ok) {
        const err = await insertResp.text();
        return res.status(500).json({ error: err });
      }

      return res.status(200).json({
        success:   true,
        count:     rowCount || positions.length,
        clients:   Object.keys(totalMtm || {}).length,
        timestamp: timestamp,
      });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('Angel API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
