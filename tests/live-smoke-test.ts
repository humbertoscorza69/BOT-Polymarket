/**
 * POL-36: Live API Smoke Test
 *
 * Verifies end-to-end: auth, balance check, order placement,
 * open orders, cancellation, and position read.
 *
 * Usage: npx ts-node tests/live-smoke-test.ts
 *
 * Requires .env with:
 *   POLY_PRIVATE_KEY, POLY_FUNDER_ADDRESS, POLY_API_KEY, POLY_API_SECRET, POLY_API_PASSPHRASE
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { ClobClient, Chain, Side, OrderType } from '@polymarket/clob-client';
import { Wallet, providers } from 'ethers';

const SIGNATURE_TYPE = 1; // POLY_GNOSIS_SAFE as specified in POL-36
const FUNDER_ADDRESS = '0x425671d3dd8e33618fe4518f8ae05de0adf7caae';
const CLOB_HOST = process.env.POLYMARKET_HTTP || 'https://clob.polymarket.com';
const GAMMA_HOST = process.env.POLYMARKET_GAMMA || 'https://gamma-api.polymarket.com';

interface TestResult {
  step: string;
  pass: boolean;
  detail: string;
  data?: unknown;
}

const results: TestResult[] = [];

function record(step: string, pass: boolean, detail: string, data?: unknown) {
  results.push({ step, pass, detail, data });
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${step}: ${detail}`);
  if (data && !pass) console.log('  data:', JSON.stringify(data, null, 2));
}

async function findTestMarket(): Promise<{ conditionId: string; yesTokenId: string; slug: string } | null> {
  // Find a liquid, active market via Gamma API
  const url = `${GAMMA_HOST}/markets?limit=20&active=true&closed=false&order=volume24hr&ascending=false`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error('Gamma API error:', resp.status, await resp.text());
    return null;
  }
  const markets: any[] = await resp.json() as any[];
  for (const m of markets) {
    // clobTokenIds is a JSON-encoded string array
    let tokens: string[] = [];
    try {
      tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
    } catch { continue; }
    if (tokens && tokens.length >= 1 && m.conditionId) {
      return {
        conditionId: m.conditionId,
        yesTokenId: tokens[0], // First token is YES
        slug: m.question || m.slug || m.conditionId,
      };
    }
  }
  return null;
}

async function main() {
  console.log('=== POL-36 Live API Smoke Test ===\n');

  // Validate env
  const privateKey = process.env.POLY_PRIVATE_KEY;
  const funder = process.env.POLY_FUNDER_ADDRESS;
  const apiKey = process.env.POLY_API_KEY;
  const apiSecret = process.env.POLY_API_SECRET;
  const apiPassphrase = process.env.POLY_API_PASSPHRASE;

  if (!privateKey) { console.error('POLY_PRIVATE_KEY not set'); process.exit(1); }
  if (!funder) { console.error('POLY_FUNDER_ADDRESS not set'); process.exit(1); }

  if (funder.toLowerCase() !== FUNDER_ADDRESS.toLowerCase()) {
    console.warn(`WARNING: POLY_FUNDER_ADDRESS=${funder} does not match expected ${FUNDER_ADDRESS}`);
  }

  // ── Step 1: Auth ──
  console.log('\n--- Step 1: ClobClient Authentication ---');
  let client: ClobClient;
  try {
    const provider = new providers.JsonRpcProvider('https://polygon-rpc.com');
    const wallet = new Wallet(privateKey, provider);
    const chainId = (Chain as any).POLYGON ?? 137;

    // Always derive fresh API creds to avoid stale key issues
    const tempClient = new ClobClient(
      CLOB_HOST,
      chainId,
      wallet,
      undefined,
      SIGNATURE_TYPE,
      funder,
    );

    const ok = await tempClient.getOk();
    console.log(`  getOk: ${ok}`);

    console.log('  Deriving fresh API credentials...');
    const derived = await tempClient.createOrDeriveApiKey();
    console.log(`  Derived key: ${(derived as any).key?.substring(0, 12)}...`);

    client = new ClobClient(
      CLOB_HOST,
      chainId,
      wallet,
      derived as any,
      SIGNATURE_TYPE,
      funder,
    );

    record('1. Auth', true, `ClobClient initialized, signatureType=${SIGNATURE_TYPE}, funder=${funder}, derived fresh creds`);
  } catch (e: any) {
    record('1. Auth', false, `Auth failed: ${e.message}`, e);
    printSummary();
    process.exit(1);
  }

  // ── Step 2: Check USDC.e balance ──
  console.log('\n--- Step 2: USDC.e Balance ---');
  try {
    const bal = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' } as any);
    const usdcRaw = Number(bal?.balance ?? 0);
    const usdc = usdcRaw / 1e6;
    record('2. Balance', true, `USDC.e balance: ${usdc.toFixed(6)} (raw: ${usdcRaw})`);

    if (usdc < 0.01) {
      record('2b. Balance sufficiency', false, `Balance too low to place $0.01 order: ${usdc.toFixed(6)} USDC. Wallet needs USDC.e funding.`);
      console.log('  WARNING: Continuing to test order placement (will likely fail).');
    }
  } catch (e: any) {
    record('2. Balance', false, `Balance check failed: ${e.message}`, e);
    // Continue to try other steps anyway
  }

  // ── Find a test market ──
  console.log('\n--- Finding test market ---');
  const market = await findTestMarket();
  if (!market) {
    record('Market lookup', false, 'Could not find a suitable test market via Gamma API');
    printSummary();
    process.exit(1);
  }
  console.log(`  Market: ${market.slug.substring(0, 80)}`);
  console.log(`  conditionId: ${market.conditionId}`);
  console.log(`  YES tokenId: ${market.yesTokenId}`);

  // ── Step 3: Place $0.01 YES order ──
  console.log('\n--- Step 3: Place $0.01 YES Order ---');
  let orderId = '';
  try {
    // Price 0.01 = buying YES at 1 cent (very low, will sit on book)
    // Polymarket minimum order size is 5 shares
    const order = await client.createOrder({
      tokenID: market.yesTokenId,
      price: 0.01,
      side: Side.BUY,
      size: 5,
      feeRateBps: 0,
    } as any);

    const result = await client.postOrder(order, OrderType.GTC);
    orderId = String((result as any)?.orderID ?? (result as any)?.orderId ?? (result as any)?.id ?? '');
    const success = Boolean((result as any)?.success ?? orderId);

    if (success && orderId) {
      record('3. Place order', true, `Order placed, orderId=${orderId}`, result);
    } else {
      record('3. Place order', false, `Order post returned no success/orderId`, result);
    }
  } catch (e: any) {
    record('3. Place order', false, `Order placement failed: ${e.message}`, e);
    printSummary();
    process.exit(1);
  }

  // ── Step 4: Confirm order in open orders ──
  console.log('\n--- Step 4: Confirm Order in Open Orders ---');
  try {
    // Small delay to let the order propagate
    await sleep(1500);
    const openOrders: any[] = await client.getOpenOrders() as any;
    const found = openOrders.some((o: any) =>
      String(o.id ?? o.orderID ?? o.orderId) === orderId
    );
    record('4. Open orders', found,
      found
        ? `Order ${orderId} found in ${openOrders.length} open orders`
        : `Order ${orderId} NOT found in ${openOrders.length} open orders`,
      { totalOpen: openOrders.length, orderIds: openOrders.map((o: any) => o.id ?? o.orderID).slice(0, 5) }
    );
  } catch (e: any) {
    record('4. Open orders', false, `Failed to fetch open orders: ${e.message}`, e);
  }

  // ── Step 5: Cancel the order ──
  console.log('\n--- Step 5: Cancel Order ---');
  try {
    const cancelResult = await client.cancelOrder({ orderID: orderId } as any);
    record('5. Cancel order', true, `Cancel result: ${JSON.stringify(cancelResult)}`);
  } catch (e: any) {
    record('5. Cancel order', false, `Cancel failed: ${e.message}`, e);
  }

  // ── Step 6: Confirm cancel succeeded ──
  console.log('\n--- Step 6: Confirm Cancellation ---');
  try {
    await sleep(1500);
    const openOrders: any[] = await client.getOpenOrders() as any;
    const stillThere = openOrders.some((o: any) =>
      String(o.id ?? o.orderID ?? o.orderId) === orderId
    );
    record('6. Confirm cancel', !stillThere,
      stillThere
        ? `Order ${orderId} STILL in open orders after cancel`
        : `Order ${orderId} successfully removed from open orders (${openOrders.length} remaining)`
    );
  } catch (e: any) {
    record('6. Confirm cancel', false, `Failed to verify cancel: ${e.message}`, e);
  }

  // ── Step 7: Read positions (reconciler compatibility) ──
  console.log('\n--- Step 7: Read Positions ---');
  try {
    // Try getTrades as a proxy for position reading capability
    const trades = await client.getTrades();
    const tradeCount = Array.isArray(trades) ? trades.length : 0;
    record('7. Positions/Trades', true,
      `getTrades() returned ${tradeCount} trades. Reconciler can read trade history.`
    );
  } catch (e: any) {
    record('7. Positions/Trades', false, `getTrades failed: ${e.message}`, e);
  }

  // ── Summary ──
  printSummary();
}

function printSummary() {
  console.log('\n========== SMOKE TEST SUMMARY ==========');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log('');
  for (const r of results) {
    console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.step}: ${r.detail}`);
  }
  console.log('=========================================');
  if (failed > 0) process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(e => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
