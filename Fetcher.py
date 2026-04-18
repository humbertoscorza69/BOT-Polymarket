import time
import requests
from datetime import datetime, timezone

BASE_URL = "https://data-api.polymarket.com/activity"

def fetch_polymarket_trades_last_24h(wallet: str, limit_per_page: int = 500):
    """
    Fetch all TRADE activity for a Polymarket wallet in the last 24 hours.

    Args:
        wallet: 0x... wallet address
        limit_per_page: API page size (max 500 per docs)

    Returns:
        List of trade dicts
    """
    end_ts = int(time.time())
    start_ts = end_ts - 24 * 60 * 60

    all_trades = []
    offset = 0

    while True:
        params = {
            "user": wallet,
            "type": "TRADE",
            "start": start_ts,
            "end": end_ts,
            "limit": limit_per_page,
            "offset": offset,
            "sortBy": "TIMESTAMP",
            "sortDirection": "DESC",
        }

        resp = requests.get(BASE_URL, params=params, timeout=20)
        resp.raise_for_status()
        batch = resp.json()

        if not batch:
            break

        all_trades.extend(batch)

        if len(batch) < limit_per_page:
            break

        offset += limit_per_page

    return all_trades


def pretty_print_trades(trades):
    if not trades:
        print("No trades found in the last 24 hours.")
        return

    print(f"Found {len(trades)} trades in the last 24 hours:\n")

    for i, t in enumerate(trades, 1):
        ts = t.get("timestamp")
        # Polymarket docs show int64 timestamp, but do not clearly label seconds vs ms.
        # This handles both safely.
        if ts and ts > 10**12:
            dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
        else:
            dt = datetime.fromtimestamp(ts, tz=timezone.utc) if ts else None

        title = t.get("title", "")
        outcome = t.get("outcome", "")
        side = t.get("side", "")
        price = t.get("price", "")
        size = t.get("size", "")
        usdc_size = t.get("usdcSize", "")
        tx = t.get("transactionHash", "")

        print(
            f"{i:03d}. {dt.isoformat() if dt else 'N/A'} | "
            f"{side:<4} | px={price} | size={size} | usdc={usdc_size} | "
            f"outcome={outcome} | title={title} | tx={tx}"
        )


if __name__ == "__main__":
    wallet = "0x425671d3dd8e33618fe4518f8ae05de0adf7caae"
    trades = fetch_polymarket_trades_last_24h(wallet)
    pretty_print_trades(trades)