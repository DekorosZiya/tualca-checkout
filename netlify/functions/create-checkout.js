// netlify/functions/create-checkout.js
// Shopify OAuth App (Client Credentials) ile Draft Order oluşturur

const PRICE_MAP = {
  'Nonwoven':       40,
  'Textile Vinyl':  45,
  'Peel and Stick': 50,
  'Cream Straw':    85,
  'Gold Cork':      85,
  'Glossy Gold':    85,
};

const UNIT_TO_CM = { inch: 2.54, ft: 30.48, cm: 1, m: 100 };

function calcAreaM2(w, h, unit) {
  const f = UNIT_TO_CM[unit] || 1;
  return Math.max((w * f / 100) * (h * f / 100), 0.01);
}

async function getAccessToken(shopDomain, clientId, clientSecret) {
  const res = await fetch(
    `https://${shopDomain}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    'client_credentials',
      }),
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token exchange failed: ${txt}`);
  }
  const data = await res.json();
  return data.access_token;
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin':  'https://tualca.com',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { width, height, unit, material, productTitle, productUrl } = body;
  if (!width || !height || !unit || !material)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };

  const pricePerM2 = PRICE_MAP[material];
  if (!pricePerM2)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid material' }) };

  const areaM2     = calcAreaM2(parseFloat(width), parseFloat(height), unit);
  const totalPrice = (areaM2 * pricePerM2).toFixed(2);

  const shopDomain   = process.env.SHOPIFY_STORE_DOMAIN; // tualca.myshopify.com
  const clientId     = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shopDomain || !clientId || !clientSecret)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server config error' }) };

  try {
    // Shopify yeni sistemde installed app token'ı bu endpoint'ten alınır
    const tokenRes = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    });

    let accessToken;
    if (tokenRes.ok) {
      const tokenData = await tokenRes.json();
      accessToken = tokenData.access_token;
    } else {
      // Fallback: secret'ı direkt token olarak kullan (bazı app tiplerinde çalışır)
      accessToken = clientSecret;
    }

    const draftRes = await fetch(
      `https://${shopDomain}/admin/api/2024-01/draft_orders.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type':             'application/json',
          'X-Shopify-Access-Token':   accessToken,
        },
        body: JSON.stringify({
          draft_order: {
            line_items: [{
              title:    productTitle || 'Custom Wallpaper',
              price:    totalPrice,
              quantity: 1,
              properties: [
                { name: 'Width',        value: `${width} ${unit}` },
                { name: 'Height',       value: `${height} ${unit}` },
                { name: 'Material',     value: material },
                { name: 'Area',         value: `~${areaM2.toFixed(2)} m²` },
                { name: 'Price per m²', value: `$${pricePerM2}` },
                { name: 'Product URL',  value: productUrl || '' },
              ],
            }],
            note: `Custom wallpaper | ${width}x${height} ${unit} | ${material} | $${pricePerM2}/m² | Total: $${totalPrice}`,
            tags: 'custom-wallpaper,calculator',
          },
        }),
      }
    );

    if (!draftRes.ok) {
      const err = await draftRes.text();
      console.error('Shopify draft error:', err);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Shopify API error', detail: err }) };
    }

    const data        = await draftRes.json();
    const checkoutUrl = data.draft_order?.invoice_url;
    if (!checkoutUrl)
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'No checkout URL' }) };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ checkoutUrl, total: `$${totalPrice}`, areaM2: areaM2.toFixed(2) }),
    };

  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
