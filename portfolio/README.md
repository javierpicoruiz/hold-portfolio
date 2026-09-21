# HOLD — Portfolio Tracker

A private-by-default mobile-friendly portfolio dashboard intended for GitHub Pages.

- Market data is refreshed by GitHub Actions every 15 minutes on weekdays during UK/US market hours.
- Holdings and book costs are **not committed** to GitHub. They live in browser `localStorage`.
- US stocks are converted to GBP using contemporaneous GBP/USD history for the one-year charts.
- The BlackRock iShares Corporate Bond Index Fund Class D Inc (GB00B7J60R40 / MEX MYKAAN) uses BlackRock's daily NAV where available.
- Portfolio history is private and starts building locally on each device after setup.

## Privacy

Never add a private portfolio JSON file to the repository. Import it in the UI or via the one-time `#import=` URL fragment, which stays client-side and is removed after import.

## Accuracy

This is a personal dashboard, not an execution or accounting system. Market data can be delayed, exchange prices may differ from a bank's displayed conversion, and the UK fund publishes daily rather than intraday NAV.
